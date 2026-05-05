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

const DEFAULT_HEADERS = Object.freeze({
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
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
const SAFE_QUERY_RE = /^[A-Za-z0-9_\-+.]{1,64}$/;

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
  const m = TITLE_RE.exec(String(html));
  if (!m) return "";
  return decodeEntities(m[1]).trim();
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

function isInterviewRelated({ title, text }) {
  const haystack = `${title}\n${text}`;
  return INTERVIEW_KEYWORDS.filter((k) => haystack.includes(k));
}

function discoverArticleLinks(html, baseUrl) {
  const anchors = extractAnchors(html);
  const hosts = new Set(["www.nowcoder.com", "nowcoder.com"]);
  const urls = new Set();
  for (const { href } of anchors) {
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
    // Drop query strings and fragments to dedupe.
    parsed.search = "";
    parsed.hash = "";
    urls.add(parsed.toString());
  }
  return [...urls];
}

async function defaultHttpFetch(url, { headers, signal } = {}) {
  const response = await fetch(url, {
    headers: { ...DEFAULT_HEADERS, ...(headers ?? {}) },
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
  searchUrlTemplate = DEFAULT_SEARCH_URL_TEMPLATE,
  now = nowIso,
  delayMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  function buildSearchUrl(query) {
    return searchUrlTemplate.replace("{query}", encodeURIComponent(query));
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

  /**
   * Convert a single fetched article URL into an ArticleRecord (sans id —
   * the api layer generates that).
   */
  function toArticleRecord({ url, html, query }) {
    const title = extractTitle(html) || "NowCoder 抓取(无标题)";
    const text = stripHtml(html);
    return {
      source: "nowcoder",
      sourceUrl: url,
      query,
      title,
      text,
      fetchedAt: now(),
      rawMetadata: {
        interviewKeywords: isInterviewRelated({ title, text })
      }
    };
  }

  /**
   * Run a search for `query` and return up to `maxArticles` ArticleRecord
   * objects. Rate limiting: `delayMs` between every article fetch.
   *
   * `excludeUrls` is an optional iterable of sourceUrl strings the caller
   * already has stored. We drop matching links BEFORE fetching, so a
   * re-run on the same query never wastes a network round trip nor
   * inserts a duplicate. The skipped links are returned as a separate
   * `skipped` array so the UI can display "已跳过 N 篇旧文章".
   */
  async function searchAndFetch({ query, maxArticles = 3, excludeUrls = [] } = {}) {
    if (typeof query !== "string" || !SAFE_QUERY_RE.test(query)) {
      throw new ValidationError(
        "query must be 1-64 chars of A-Za-z0-9_-+.",
        { code: "NOWCODER_INPUT_INVALID", path: "query" }
      );
    }
    if (!Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > 20) {
      throw new ValidationError("maxArticles must be an integer in [1, 20]", {
        code: "NOWCODER_INPUT_INVALID",
        path: "maxArticles"
      });
    }

    const skipSet = new Set();
    for (const u of excludeUrls ?? []) {
      if (typeof u === "string" && u.length > 0) skipSet.add(u);
    }

    const searchUrl = buildSearchUrl(query);
    const searchPage = await fetchHtml(searchUrl);
    const allLinks = discoverArticleLinks(searchPage.html, searchUrl);
    const skipped = allLinks.filter((u) => skipSet.has(u));
    const fresh = allLinks.filter((u) => !skipSet.has(u)).slice(0, maxArticles);

    const records = [];
    for (let i = 0; i < fresh.length; i += 1) {
      if (i > 0 && delayMs > 0) await sleep(delayMs);
      const link = fresh[i];
      try {
        const page = await fetchHtml(link);
        records.push(toArticleRecord({ url: page.finalUrl, html: page.html, query }));
      } catch (err) {
        // Per-article failures must not abort the batch — surface them in
        // a side channel so the caller can report partial success.
        records.push({
          __error: true,
          url: link,
          code: err?.code ?? "NOWCODER_ARTICLE_FAILED",
          message: err?.message ?? String(err)
        });
      }
    }
    return { searchUrl, links: fresh, skipped, records };
  }

  return {
    searchAndFetch,
    // Exposed for unit tests.
    _internals: {
      buildSearchUrl,
      discoverArticleLinks,
      toArticleRecord,
      stripHtml,
      extractTitle,
      isInterviewRelated
    }
  };
}
