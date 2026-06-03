// NowCoder source adapter — fetches public NowCoder search results and
// interview-experience articles, then transforms them into ArticleRecords.
//
// Design:
// - The adapter receives an injectable `httpFetch` so tests can run without
//   hitting the real network. In production we pass Node's global fetch.
// - HTML parsing stays minimal: we only need title + visible text + a set
//   of in-domain anchor hrefs. We rely on simple regex rather than adding
//   an HTML parser dependency.
// - Rate limiting and retry live here, not in the API layer, because any
//   future source adapter will want the same shape.
//
// Reference: old Python crawler fetch_nowcoder_interviews.py (only used
// as specification; we re-implement in Node to avoid a Python runtime).

import { ValidationError } from "../domain/errors.js";

const DEFAULT_SEARCH_URL_TEMPLATE =
  "https://www.nowcoder.com/search/all?query={query}&type=all&searchType=%E9%A1%B6%E9%83%A8%E5%AF%BC%E8%88%AA%E6%A0%8F";
const FEED_LIST_API_URL =
  "https://gw-c.nowcoder.com/api/sparta/job-experience/experience/job/list";

// Empty-query mode: hit NowCoder's fresh interview-experience listing instead
// of the broad discuss feed. The tagId keeps this scoped to a backend-ish
// software role by default; callers can override `feedUrl` when they want a
// different job track.
export const DEFAULT_FEED_URL = "https://www.nowcoder.com/discuss/experience?tagId=639";

// Sentinel query stored in ArticleRecord.query when the user did not provide
// a topic. The frontend never displays this value to the user; ArticleStore
// uses it as the dedupe partition key for feed-mode fetches.
export const FEED_QUERY_SENTINEL = "__feed__";

const DEFAULT_HEADERS = Object.freeze({
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
  Referer: "https://www.nowcoder.com/"
});
const JSON_HEADERS = Object.freeze({
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
  Referer: "https://www.nowcoder.com/"
});

const INTERVIEW_KEYWORDS = [
  "面经",
  "面试",
  "笔经",
  "秋招",
  "春招",
  "实习",
  "校招",
  "社招"
];

const CONTENT_PATH_RE =
  /^\/(discuss\/\d+|feed\/main\/detail\/[0-9a-fA-F]+|creation\/subject\/[0-9a-fA-F]+)/;
const SCRIPT_STYLE_RE = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const BLANK_LINE_RE = /\n{3,}/g;
const HORIZONTAL_WS_RE = /[ \t\r\f\v]+/g;
const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_TITLE_RE =
  /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:title|twitter:title|title)["'][^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*>/i;
const EMBEDDED_STATE_RE =
  /<script[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i;
// Accept Unicode letters/digits plus + and . (for "node.js" / "c++"); still
// rejects shell metachars, path separators, whitespace. Empty string is
// allowed at this layer — the API caller maps "" to feed mode.
const SAFE_QUERY_RE = /^[\p{L}\p{N}_\-+.]{0,64}$/u;
const MAX_LIST_PAGES = 8;
const MAX_EMPTY_LIST_PAGES = 2;

function freshCandidateTarget({ maxArticles, classifyTitles }) {
  if (!classifyTitles) return maxArticles;
  // Classify a wider pool so rejected titles do not waste the article quota.
  return Math.min(20, Math.max(maxArticles, maxArticles * 3));
}

function decodeEntities(value) {
  // Minimal entity decoder — enough for NowCoder titles.
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

function stripHtml(html) {
  return decodeEntities(
    String(html)
      .replace(SCRIPT_STYLE_RE, " ")
      .replace(TAG_RE, " ")
      .replace(HORIZONTAL_WS_RE, " ")
      .replace(BLANK_LINE_RE, "\n\n")
  ).trim();
}

function extractTitle(html) {
  const meta = META_TITLE_RE.exec(String(html));
  if (meta?.[1]) return cleanPageTitle(decodeEntities(meta[1]));
  const m = TITLE_RE.exec(String(html));
  if (!m) return "";
  return cleanPageTitle(decodeEntities(m[1]));
}

function cleanPageTitle(value) {
  return String(value ?? "")
    .replace(/[_-]\s*牛客网\s*$/u, "")
    .replace(/\s*牛客网\s*$/u, "")
    .trim();
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function shortCandidateTitle(value, { maxLength = 80 } = {}) {
  const text = normalizeWhitespace(value);
  if (!text) return "";
  const firstLine = text.split(/\n+/)[0]?.trim() || text;
  const markerMatch = /(?:面试公司|面试岗位|面试时间|面试问题|一面|二面|三面|hr面|HR面|oc|已oc|已OC)/i.exec(firstLine);
  const source = markerMatch && markerMatch.index > 0 ? firstLine.slice(0, markerMatch.index).trim() : firstLine;
  return source.length > maxLength ? `${source.slice(0, maxLength)}...` : source;
}

function extractAnchors(html) {
  const anchors = [];
  ANCHOR_RE.lastIndex = 0;
  let match;
  while ((match = ANCHOR_RE.exec(html)) !== null) {
    anchors.push({
      href: decodeEntities(match[1]).trim(),
      text: stripHtml(match[2])
    });
  }
  return anchors;
}

function absoluteUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function buildPagedUrl(url, page) {
  const parsed = new URL(url);
  if (page <= 1) {
    parsed.searchParams.delete("page");
    return parsed.toString();
  }
  parsed.searchParams.set("page", String(page));
  return parsed.toString();
}

function feedJobIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const tagId = parsed.searchParams.get("tagId");
    if (!tagId || !/^\d+$/.test(tagId)) return null;
    return Number(tagId);
  } catch {
    return null;
  }
}

function isInterviewRelated({ title, text }) {
  const haystack = `${title}\n${text}`;
  return INTERVIEW_KEYWORDS.filter((k) => haystack.includes(k));
}

function discoverArticleCandidates(html, baseUrl) {
  const anchors = extractAnchors(html);
  const hosts = new Set(["www.nowcoder.com", "nowcoder.com"]);
  const seen = new Map(); // url -> title (first non-empty wins)
  for (const { href, text } of anchors) {
    const abs = absoluteUrl(href, baseUrl);
    if (!abs) continue;
    let parsed;
    try {
      parsed = new URL(abs);
    } catch {
      continue;
    }
    if (!hosts.has(parsed.hostname)) continue;
    if (!CONTENT_PATH_RE.test(parsed.pathname)) continue;
    parsed.search = "";
    parsed.hash = "";
    const url = parsed.toString();
    const cleanTitle = shortCandidateTitle(text);
    const rawTitle = normalizeWhitespace(text);
    if (!seen.has(url)) {
      seen.set(url, { title: cleanTitle, rawTitle });
    } else if (!seen.get(url).title && cleanTitle) {
      seen.set(url, { title: cleanTitle, rawTitle });
    }
  }
  return [...seen.entries()].map(([url, v]) => ({
    url,
    title: v.title,
    rawTitle: v.rawTitle
  }));
}

function discoverArticleCandidatesFromEmbeddedState(html, baseUrl) {
  const match = EMBEDDED_STATE_RE.exec(String(html));
  if (!match?.[1]) return [];

  const candidates = [];
  const itemRe =
    /"contentId":"?(\d+)"?[\s\S]{0,500}?"momentData":\{[\s\S]{0,4000}?"title":"((?:\\.|[^"\\])*)"/g;
  let itemMatch;
  while ((itemMatch = itemRe.exec(match[1])) !== null) {
    const url = absoluteUrl(`/discuss/${itemMatch[1]}`, baseUrl);
    if (!url) continue;
    const rawTitle = normalizeWhitespace(JSON.parse(`"${itemMatch[2]}"`));
    candidates.push({
      url,
      title: shortCandidateTitle(rawTitle),
      rawTitle
    });
  }

  const seen = new Map();
  for (const candidate of candidates) {
    if (!seen.has(candidate.url)) {
      seen.set(candidate.url, candidate);
    }
  }
  return [...seen.values()];
}

function mergeCandidates(...candidateLists) {
  const seen = new Map();
  for (const list of candidateLists) {
    for (const candidate of list) {
      if (!candidate?.url) continue;
      if (!seen.has(candidate.url)) {
        seen.set(candidate.url, candidate);
      } else if (!seen.get(candidate.url).title && candidate.title) {
        seen.set(candidate.url, candidate);
      }
    }
  }
  return [...seen.values()];
}

async function defaultHttpFetch(url, { headers, signal } = {}) {
  const response = await fetch(url, {
    headers: { ...DEFAULT_HEADERS, ...(headers ?? {}) },
    signal
  });
  const text = await response.text();
  return { status: response.status, text, url };
}

async function defaultJsonFetch(url, { method = "GET", headers, body, signal } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...JSON_HEADERS, ...(headers ?? {}) },
    body,
    signal
  });
  const text = await response.text();
  return { status: response.status, text, url };
}

function nowIso() {
  return new Date().toISOString();
}

export function createNowCoderAdapter({
  httpFetch = defaultHttpFetch,
  jsonFetch = defaultJsonFetch,
  searchUrlTemplate = DEFAULT_SEARCH_URL_TEMPLATE,
  feedUrl = DEFAULT_FEED_URL,
  now = nowIso,
  delayMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  function buildSearchUrl(query) {
    return searchUrlTemplate.replace("{query}", encodeURIComponent(query));
  }

  function entryUrlFor(query) {
    return query === "" ? feedUrl : buildSearchUrl(query);
  }

  async function fetchHtml(url) {
    const response = await httpFetch(url, { headers: DEFAULT_HEADERS });
    if (!response || typeof response !== "object") {
      throw new ValidationError("httpFetch returned non-object response", {
        code: "NOWCODER_FETCH_FAILED",
        path: "response"
      });
    }
    if (response.status >= 400) {
      throw new ValidationError(
        `NowCoder responded with HTTP ${response.status}`,
        { code: "NOWCODER_FETCH_FAILED", path: "status", value: response.status }
      );
    }
    return { html: String(response.text ?? ""), finalUrl: response.url ?? url };
  }

  async function fetchJson(url, { method = "GET", body } = {}) {
    const response = await jsonFetch(url, { method, body, headers: JSON_HEADERS });
    if (!response || typeof response !== "object") {
      throw new ValidationError("jsonFetch returned non-object response", {
        code: "NOWCODER_FETCH_FAILED",
        path: "response"
      });
    }
    if (response.status >= 400) {
      throw new ValidationError(
        `NowCoder responded with HTTP ${response.status}`,
        { code: "NOWCODER_FETCH_FAILED", path: "status", value: response.status }
      );
    }
    try {
      return JSON.parse(String(response.text ?? "{}"));
    } catch {
      throw new ValidationError("NowCoder JSON response was malformed", {
        code: "NOWCODER_FETCH_FAILED",
        path: "response.text"
      });
    }
  }

  async function fetchFeedCandidatesPage({ page }) {
    const jobId = feedJobIdFromUrl(feedUrl);
    if (!jobId) {
      throw new ValidationError("feedUrl must contain a numeric tagId", {
        code: "NOWCODER_INPUT_INVALID",
        path: "feedUrl"
      });
    }
    const payload = {
      jobId,
      order: 3,
      page,
      companyList: []
    };
    const data = await fetchJson(FEED_LIST_API_URL, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const records = data?.data?.records;
    if (!Array.isArray(records)) return [];
    return records
      .map((record) => {
        const contentId = record?.contentId;
        if (typeof contentId !== "string" && typeof contentId !== "number") return null;
        const detailId = record?.momentData?.id ?? contentId;
        const title = normalizeWhitespace(record?.momentData?.title ?? "");
        return {
          url: absoluteUrl(`/discuss/${detailId}`, "https://www.nowcoder.com/"),
          title: shortCandidateTitle(title),
          rawTitle: title
        };
      })
      .filter(Boolean);
  }

  /**
   * Convert a single fetched article URL into an ArticleRecord (sans id —
   * the api layer generates that). storedQuery is what gets written into
   * ArticleRecord.query — for feed mode this is FEED_QUERY_SENTINEL; for
   * search mode it equals the user's query verbatim.
   */
  function toArticleRecord({ url, html, storedQuery, classifierTitle = null }) {
    const pageTitle = extractTitle(html);
    const title = pageTitle || classifierTitle || "NowCoder 抓取(无标题)";
    const text = stripHtml(html);
    return {
      source: "nowcoder",
      sourceUrl: url,
      query: storedQuery,
      title,
      text,
      fetchedAt: now(),
      rawMetadata: {
        interviewKeywords: isInterviewRelated({ title, text })
      }
    };
  }

  /**
   * Run a search (or fetch the feed when query==="") and return up to
   * `maxArticles` ArticleRecord objects.
   *
   * `excludeUrls` — adapter drops matching links BEFORE classification or
   * detail fetch, so a re-run on the same query never wastes a network
   * round trip nor inserts a duplicate.
   *
   * `classifyTitles?: (titles[]) => Promise<bool[]>` — if provided, called
   * AFTER url-dedupe and BEFORE detail fetch. Only candidates classified
   * `true` proceed to detail fetch + ArticleRecord. The two outputs
   * `classifiedYes` and `classifiedNo` are exposed in the return value so
   * the API/UI can show counts. If the classifier throws or returns a
   * malformed array, we fall back to "all candidates skipped" (safe choice:
   * worse to pollute the question pool with non-面经 articles than to miss
   * a few real ones).
   */
  async function searchAndFetch({
    query,
    maxArticles = 3,
    offset = 0,
    excludeUrls = [],
    classifyTitles = null
  } = {}) {
    if (typeof query !== "string" || !SAFE_QUERY_RE.test(query)) {
      throw new ValidationError(
        "query must be 0-64 chars of A-Za-z0-9_-+. (empty allowed)",
        { code: "NOWCODER_INPUT_INVALID", path: "query" }
      );
    }
    if (!Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > 20) {
      throw new ValidationError("maxArticles must be an integer in [1, 20]", {
        code: "NOWCODER_INPUT_INVALID",
        path: "maxArticles"
      });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError("offset must be a non-negative integer", {
        code: "NOWCODER_INPUT_INVALID",
        path: "offset"
      });
    }

    const skipSet = new Set();
    for (const u of excludeUrls ?? []) {
      if (typeof u === "string" && u.length > 0) skipSet.add(u);
    }

    const freshTarget = freshCandidateTarget({ maxArticles, classifyTitles });

    const isFeedMode = query === "";
    const storedQuery = isFeedMode ? FEED_QUERY_SENTINEL : query;
    const entryUrl = entryUrlFor(query);
    const allCandidates = [];
    const seenCandidateUrls = new Set();
    let page = 1;
    let exhausted = false;
    let consecutiveEmptyPages = 0;

    while (!exhausted && page <= MAX_LIST_PAGES) {
      const pageUrl = buildPagedUrl(entryUrl, page);
      let pageCandidates;
      if (isFeedMode) {
        pageCandidates = await fetchFeedCandidatesPage({ page });
      } else {
        const entryPage = await fetchHtml(pageUrl);
        pageCandidates = mergeCandidates(
          discoverArticleCandidates(entryPage.html, pageUrl),
          discoverArticleCandidatesFromEmbeddedState(entryPage.html, pageUrl)
        );
      }
      let newCount = 0;
      for (const candidate of pageCandidates) {
        if (seenCandidateUrls.has(candidate.url)) continue;
        seenCandidateUrls.add(candidate.url);
        allCandidates.push(candidate);
        newCount += 1;
      }

      const availableAfterOffset = allCandidates.slice(offset);
      let traversedCount = 0;
      let freshEnough = 0;
      for (const candidate of availableAfterOffset) {
        traversedCount += 1;
        if (!skipSet.has(candidate.url)) {
          freshEnough += 1;
          if (freshEnough >= freshTarget) break;
        }
      }
      if (freshEnough >= freshTarget) break;

      if (pageCandidates.length === 0 || newCount === 0) {
        consecutiveEmptyPages += 1;
        if (consecutiveEmptyPages >= MAX_EMPTY_LIST_PAGES) {
          exhausted = true;
          break;
        }
        page += 1;
        continue;
      }
      consecutiveEmptyPages = 0;
      page += 1;
    }

    const sliced = allCandidates.slice(offset);
    const skipped = sliced.filter((c) => skipSet.has(c.url)).map((c) => c.url);
    const freshPool = [];
    let consumedCount = 0;
    for (const candidate of sliced) {
      consumedCount += 1;
      if (skipSet.has(candidate.url)) continue;
      freshPool.push(candidate);
      if (freshPool.length >= freshTarget) break;
    }

    let interviewFlags = freshPool.map(() => true);
    let classifiedNo = [];
    let classifiedYes = freshPool.map((c) => c.url);
    let classifyError = null;

    if (classifyTitles && freshPool.length > 0) {
      try {
        const titles = freshPool.map((c) => c.title || "");
        const result = await classifyTitles(titles);
        if (Array.isArray(result)) {
          interviewFlags = freshPool.map((_, i) => result[i] !== false);
        } else {
          classifyError = new Error("classifyTitles returned a malformed result");
        }
      } catch (err) {
        classifyError = err;
      }
      if (classifyError) {
        // Classification is a noise-reduction hint, not a production gate.
        // If it fails, keep every fresh candidate and let extraction decide.
        interviewFlags = freshPool.map(() => true);
      }
      classifiedYes = freshPool
        .filter((_, i) => interviewFlags[i])
        .map((c) => c.url);
      classifiedNo = freshPool
        .filter((_, i) => !interviewFlags[i])
        .map((c) => c.url);
    }

    const fresh = [];
    for (let i = 0; i < freshPool.length; i += 1) {
      if (!interviewFlags[i]) continue;
      fresh.push(freshPool[i]);
      if (fresh.length >= maxArticles) break;
    }

    const records = [];
    for (let i = 0; i < fresh.length; i += 1) {
      if (records.length > 0 && delayMs > 0) await sleep(delayMs);
      const cand = fresh[i];
      try {
        const page = await fetchHtml(cand.url);
        records.push(
          toArticleRecord({
            url: page.finalUrl,
            html: page.html,
            storedQuery,
            classifierTitle: cand.title || null
          })
        );
        const last = records[records.length - 1];
        if (last && !last.__error && cand.rawTitle && cand.rawTitle !== cand.title) {
          last.rawMetadata = {
            ...(last.rawMetadata ?? {}),
            listingText: cand.rawTitle
          };
        }
      } catch (err) {
        records.push({
          __error: true,
          url: cand.url,
          code: err?.code ?? "NOWCODER_ARTICLE_FAILED",
          message: err?.message ?? String(err)
        });
      }
    }

    return {
      entryUrl,
      searchUrl: entryUrl, // kept for back-compat with callers/tests
      mode: isFeedMode ? "feed" : "search",
      offset,
      nextOffset: offset + consumedCount,
      totalCandidates: allCandidates.length,
      links: fresh.map((c) => c.url),
      candidates: fresh,
      skipped,
      classifiedYes,
      classifiedNo,
      classifyError: classifyError
        ? { message: classifyError.message ?? String(classifyError), code: classifyError.code ?? null }
        : null,
      records
    };
  }

  return {
    searchAndFetch,
    // Exposed for unit tests.
    _internals: {
      buildSearchUrl,
      buildPagedUrl,
      feedJobIdFromUrl,
      entryUrlFor,
      fetchFeedCandidatesPage,
      discoverArticleCandidates,
      discoverArticleCandidatesFromEmbeddedState,
      mergeCandidates,
      toArticleRecord,
      stripHtml,
      extractTitle,
      shortCandidateTitle,
      isInterviewRelated
    }
  };
}
