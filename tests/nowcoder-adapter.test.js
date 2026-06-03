import assert from "node:assert/strict";
import test from "node:test";
import {
  createNowCoderAdapter,
  DEFAULT_FEED_URL
} from "../src/sources/nowcoderAdapter.js";
import { ValidationError } from "../src/domain/errors.js";

function mockFetchByUrl(mapping) {
  const calls = [];
  async function httpFetch(url) {
    calls.push(url);
    const entry = mapping[url];
    if (!entry) {
      return { status: 404, text: "<html><body>not found</body></html>", url };
    }
    if (typeof entry === "string") {
      return { status: 200, text: entry, url };
    }
    return { ...entry, url };
  }
  return { httpFetch, calls };
}

/** Force legacy HTML search path in unit tests (avoid live pc/search API). */
function createAdapterForHtmlSearch(options = {}) {
  const { httpFetch, jsonFetch, ...rest } = options;
  return createNowCoderAdapter({
    httpFetch,
    jsonFetch:
      jsonFetch ??
      (async (url) => {
        if (String(url).includes("/api/sparta/pc/search")) {
          return { status: 404, text: "{}", url };
        }
        return { status: 404, text: "{}", url };
      }),
    ...rest
  });
}

const SEARCH_HTML_BASE = `<!doctype html>
<html><head><title>search</title></head><body>
<a href="/discuss/123">ByteDance MySQL interview notes</a>
<a href="/discuss/456">Meituan backend interview notes</a>
<a href="https://other.com/x">external link</a>
<a href="/some/unrelated/path">unrelated path</a>
</body></html>`;

const ARTICLE_1 = `<!doctype html>
<html><head><title>ByteDance MySQL interview notes</title></head>
<body><h1>ByteDance</h1>
<p>Asked about ACID and indexes.</p>
<script>window.__INITIAL_STATE__ = {}</script>
</body></html>`;

const ARTICLE_2 = `<!doctype html>
<html><head><title>Meituan backend interview notes</title></head>
<body><p>Asked about replication lag and locks.</p></body></html>`;

test("searchAndFetch returns ArticleRecord-shaped objects for discovered links", async () => {
  const { httpFetch } = mockFetchByUrl({
    "https://www.nowcoder.com/search/all?query=mysql&type=all&searchType=%E9%A1%B6%E9%83%A8%E5%AF%BC%E8%88%AA%E6%A0%8F":
      SEARCH_HTML_BASE,
    "https://www.nowcoder.com/search/all?query=mysql&type=all&searchType=%E9%A1%B6%E9%83%A8%E5%AF%BC%E8%88%AA%E6%A0%8F&page=2":
      "<html><body></body></html>",
    "https://www.nowcoder.com/search/all?query=mysql&type=all&searchType=%E9%A1%B6%E9%83%A8%E5%AF%BC%E8%88%AA%E6%A0%8F&page=3":
      "<html><body></body></html>",
    "https://www.nowcoder.com/discuss/123": ARTICLE_1,
    "https://www.nowcoder.com/discuss/456": ARTICLE_2
  });
  const adapter = createAdapterForHtmlSearch({
    httpFetch,
    now: () => "2026-05-05T10:00:00Z"
  });

  const result = await adapter.searchAndFetch({ query: "mysql", maxArticles: 3 });

  assert.equal(result.links.length, 2);
  assert.equal(result.records.length, 2);
  for (const r of result.records) {
    assert.equal(r.source, "nowcoder");
    assert.equal(r.query, "mysql");
    assert.equal(r.fetchedAt, "2026-05-05T10:00:00Z");
    assert.ok(r.title.length > 0);
    assert.ok(r.text.length > 0);
    assert.match(r.sourceUrl, /^https:\/\/www\.nowcoder\.com\/discuss\/\d+$/);
    assert.ok(Array.isArray(r.rawMetadata.interviewKeywords));
  }
});

test("rejects an unsafe query string", async () => {
  const adapter = createNowCoderAdapter({ httpFetch: () => ({ status: 200, text: "" }) });
  await assert.rejects(
    adapter.searchAndFetch({ query: "mysql;drop" }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, "NOWCODER_INPUT_INVALID");
      return true;
    }
  );
});

test("empty query uses the fresh interview-experience feed by default", () => {
  const adapter = createNowCoderAdapter({ httpFetch: async () => ({ status: 200, text: "" }) });
  assert.equal(adapter._internals.entryUrlFor(""), DEFAULT_FEED_URL);
});

test("empty query feed URL can be overridden for a different job track", () => {
  const feedUrl = "https://www.nowcoder.com/discuss/experience?tagId=777";
  const adapter = createNowCoderAdapter({
    feedUrl,
    httpFetch: async () => ({ status: 200, text: "" })
  });
  assert.equal(adapter._internals.entryUrlFor(""), feedUrl);
});

test("rejects a search-page HTTP failure with a visible error", async () => {
  const httpFetch = async () => ({ status: 500, text: "server error" });
  const adapter = createAdapterForHtmlSearch({ httpFetch });
  await assert.rejects(
    adapter.searchAndFetch({ query: "mysql" }),
    (err) => {
      assert.equal(err.code, "NOWCODER_FETCH_FAILED");
      return true;
    }
  );
});

test("per-article fetch failures are reported but do not abort the batch", async () => {
  const httpFetch = async (url) => {
    if (url.includes("/search/")) return { status: 200, text: SEARCH_HTML_BASE };
    if (url.endsWith("/discuss/123")) return { status: 200, text: ARTICLE_1 };
    if (url.endsWith("/discuss/456")) return { status: 502, text: "bad gateway" };
    return { status: 404, text: "" };
  };
  const adapter = createAdapterForHtmlSearch({ httpFetch });

  const result = await adapter.searchAndFetch({ query: "mysql", maxArticles: 2 });
  const successes = result.records.filter((r) => !r.__error);
  const failures = result.records.filter((r) => r.__error);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0].url, /456$/);
});

test("maxArticles bounds the fetch count and sleep is called between fetches", async () => {
  const httpFetch = async (url) => {
    if (url.includes("/search/")) {
      const links = Array.from({ length: 5 }, (_, i) =>
        `<a href="/discuss/${100 + i}">interview #${i}</a>`
      ).join("\n");
      return { status: 200, text: `<html><body>${links}</body></html>` };
    }
    return { status: 200, text: "<html><title>t</title><body>interview</body></html>" };
  };
  const sleeps = [];
  const adapter = createAdapterForHtmlSearch({
    httpFetch,
    delayMs: 7,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    }
  });

  const result = await adapter.searchAndFetch({ query: "mysql", maxArticles: 2 });
  assert.equal(result.records.length, 2);
  assert.deepEqual(sleeps, [7]);
});

test("toArticleRecord strips script/style and preserves title", () => {
  const adapter = createNowCoderAdapter({
    httpFetch: async () => ({ status: 200, text: "" }),
    now: () => "T"
  });
  const record = adapter._internals.toArticleRecord({
    url: "https://www.nowcoder.com/discuss/1",
    html:
      "<html><head><title>ByteDance MySQL interview</title></head><body>" +
      "<script>bad()</script><p>Question 1: ACID</p>" +
      "<style>.x{color:red}</style>" +
      "</body></html>",
    storedQuery: "mysql"
  });
  assert.equal(record.source, "nowcoder");
  assert.equal(record.title, "ByteDance MySQL interview");
  assert.match(record.text, /ACID/);
  assert.doesNotMatch(record.text, /bad\(\)/);
  assert.doesNotMatch(record.text, /color:red/);
});

test("toArticleRecord prefers detail page title over listing preview text", () => {
  const adapter = createNowCoderAdapter({
    httpFetch: async () => ({ status: 200, text: "" }),
    now: () => "T"
  });
  const record = adapter._internals.toArticleRecord({
    url: "https://www.nowcoder.com/feed/main/detail/abc",
    html:
      "<html><head><meta property=\"og:title\" content=\"Detailed title - 牛客网\"></head>" +
      "<body>正文 Redis and MySQL</body></html>",
    storedQuery: "__feed__",
    classifierTitle: "listing preview"
  });
  assert.equal(record.title, "Detailed title");
});

test("discoverArticleCandidates deduplicates trailing query strings", () => {
  const adapter = createNowCoderAdapter({ httpFetch: async () => ({ status: 200, text: "" }) });
  const candidates = adapter._internals.discoverArticleCandidates(
    `<a href="/discuss/1?ref=a">x</a>
     <a href="/discuss/1?ref=b">y</a>
     <a href="/discuss/2#top">z</a>`,
    "https://www.nowcoder.com/search"
  );
  const links = candidates.map((c) => c.url);
  assert.equal(links.length, 2);
  assert.ok(links.includes("https://www.nowcoder.com/discuss/1"));
  assert.ok(links.includes("https://www.nowcoder.com/discuss/2"));
  assert.deepEqual(
    candidates.map((c) => c.title),
    ["x", "z"]
  );
});

test("discoverArticleCandidates trims long feed previews into short titles", () => {
  const adapter = createNowCoderAdapter({ httpFetch: async () => ({ status: 200, text: "" }) });
  const longPreview =
    "This is a very long listing preview that should be trimmed before it is used as a candidate title because it contains too much detail.";
  const candidates = adapter._internals.discoverArticleCandidates(
    `<a href="/feed/main/detail/c326baa3dac7472d89066c80b8749bdc">${longPreview}</a>`,
    "https://www.nowcoder.com/discuss/experience?tagId=639"
  );
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].title.length <= 83);
  assert.notEqual(candidates[0].title, longPreview);
  assert.equal(candidates[0].rawTitle, longPreview);
});

test("discoverArticleCandidatesFromEmbeddedState parses SSR state payloads", () => {
  const adapter = createNowCoderAdapter({ httpFetch: async () => ({ status: 200, text: "" }) });
  const html = `
    <html><body>
    <script>window.__INITIAL_STATE__ = {"experience":{"experienceData":{"contentList":[
      {"contentId":"2846183","momentData":{"title":"Insurance Java role"}},
      {"contentId":"2845869","momentData":{"title":"Sida round one"}},
      {"contentId":"2846183","momentData":{"title":"duplicate"}}
    ]}}};</script>
    </body></html>
  `;
  const candidates = adapter._internals.discoverArticleCandidatesFromEmbeddedState(
    html,
    "https://www.nowcoder.com/discuss/experience?tagId=639&page=2"
  );
  assert.deepEqual(
    candidates.map((c) => c.url),
    [
      "https://www.nowcoder.com/discuss/2846183",
      "https://www.nowcoder.com/discuss/2845869"
    ]
  );
  assert.equal(candidates[0].rawTitle, "Insurance Java role");
});

test("searchAndFetch keeps full listing text in metadata when candidate title was shortened", async () => {
  const listingText =
    "This is an overlong preview line that should be shortened for the candidate title but still preserved in metadata.";
  const searchHtml = `<a href="/discuss/999">${listingText}</a>`;
  const articleHtml =
    "<html><head><title>Detailed title</title></head><body>Redis and MySQL正文</body></html>";
  const adapter = createAdapterForHtmlSearch({
    httpFetch: async (url) => {
      if (url.includes("/search/all")) return { status: 200, text: searchHtml, url };
      return { status: 200, text: articleHtml, url };
    }
  });

  const result = await adapter.searchAndFetch({ query: "redis", maxArticles: 1 });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].rawMetadata.listingText, listingText);
  assert.ok(result.records[0].rawMetadata.listingText.length > result.records[0].title.length);
});

test("excludeUrls skips already-known links and reports them as skipped", async () => {
  const fetchedUrls = [];
  const httpFetch = async (url) => {
    fetchedUrls.push(url);
    if (url.includes("/search/")) {
      return { status: 200, text: SEARCH_HTML_BASE };
    }
    return { status: 200, text: ARTICLE_1 };
  };
  const adapter = createAdapterForHtmlSearch({ httpFetch });

  const result = await adapter.searchAndFetch({
    query: "mysql",
    maxArticles: 5,
    excludeUrls: ["https://www.nowcoder.com/discuss/123"]
  });

  assert.ok(!fetchedUrls.some((u) => u.endsWith("/discuss/123")));
  assert.ok(fetchedUrls.some((u) => u.endsWith("/discuss/456")));
  assert.equal(result.records.length, 1);
  assert.equal(result.links.length, 1);
  assert.deepEqual(result.skipped, ["https://www.nowcoder.com/discuss/123"]);
});

test("excludeUrls default preserves the original behavior", async () => {
  const httpFetch = async (url) => {
    if (url.includes("/search/")) return { status: 200, text: SEARCH_HTML_BASE };
    if (url.endsWith("/discuss/123")) return { status: 200, text: ARTICLE_1 };
    return { status: 200, text: ARTICLE_2 };
  };
  const adapter = createAdapterForHtmlSearch({ httpFetch });
  const result = await adapter.searchAndFetch({ query: "mysql", maxArticles: 5 });
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.skipped, []);
});

test("feed mode fetches page 2 from the JSON list API when page 1 candidates are insufficient", async () => {
  const calls = [];
  const adapter = createNowCoderAdapter({
    jsonFetch: async (url, { body }) => {
      const payload = JSON.parse(body);
      calls.push({ url, payload });
      if (payload.page === 1) {
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            data: {
              records: [{ contentId: "8761", momentData: { id: 101, title: "page1-1" } }]
            }
          }),
          url
        };
      }
      if (payload.page === 2) {
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            data: {
              records: [
                { contentId: "8762", momentData: { id: 201, title: "page2-1" } },
                { contentId: "8763", momentData: { id: 202, title: "page2-2" } }
              ]
            }
          }),
          url
        };
      }
      return {
        status: 200,
        text: JSON.stringify({ success: true, data: { records: [] } }),
        url
      };
    },
    httpFetch: async (url) => ({
      status: 200,
      text: "<html><head><title>detail</title></head><body>interview body</body></html>",
      url
    })
  });

  const result = await adapter.searchAndFetch({ query: "", maxArticles: 2 });
  assert.equal(result.records.length, 2);
  assert.ok(calls.some((entry) => entry.payload.page === 2));
  assert.equal(calls[0].payload.jobId, 639);
  assert.deepEqual(result.links, [
    "https://www.nowcoder.com/discuss/101",
    "https://www.nowcoder.com/discuss/201"
  ]);
});

test("nextOffset advances by traversed feed candidates including skipped old links", async () => {
  const adapter = createNowCoderAdapter({
    jsonFetch: async (url, { body }) => {
      const payload = JSON.parse(body);
      if (payload.page === 1) {
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            data: {
              records: [
                { contentId: "8761", momentData: { id: 101, title: "page1-1" } },
                { contentId: "8762", momentData: { id: 102, title: "page1-2" } },
                { contentId: "8763", momentData: { id: 103, title: "page1-3" } }
              ]
            }
          }),
          url
        };
      }
      return {
        status: 200,
        text: JSON.stringify({ success: true, data: { records: [] } }),
        url
      };
    },
    httpFetch: async (url) => ({
      status: 200,
      text: "<html><head><title>detail</title></head><body>interview body</body></html>",
      url
    })
  });

  const result = await adapter.searchAndFetch({
    query: "",
    maxArticles: 2,
    excludeUrls: ["https://www.nowcoder.com/discuss/101"]
  });
  assert.deepEqual(result.skipped, ["https://www.nowcoder.com/discuss/101"]);
  assert.deepEqual(result.links, [
    "https://www.nowcoder.com/discuss/102",
    "https://www.nowcoder.com/discuss/103"
  ]);
  assert.equal(result.nextOffset, 3);
});

test("classifyTitles uses a wider pool so rejected titles do not shrink the fetch quota", async () => {
  const records = [
    { contentId: "1", momentData: { id: 101, title: "noise-1" } },
    { contentId: "2", momentData: { id: 102, title: "字节一面 MySQL" } },
    { contentId: "3", momentData: { id: 103, title: "noise-2" } },
    { contentId: "4", momentData: { id: 104, title: "美团 Java 二面" } },
    { contentId: "5", momentData: { id: 105, title: "noise-3" } },
    { contentId: "6", momentData: { id: 106, title: "腾讯后台开发一面" } }
  ];
  const adapter = createNowCoderAdapter({
    jsonFetch: async (url, { body }) => {
      const payload = JSON.parse(body);
      if (payload.page !== 1) {
        return {
          status: 200,
          text: JSON.stringify({ success: true, data: { records: [] } }),
          url
        };
      }
      return {
        status: 200,
        text: JSON.stringify({ success: true, data: { records } }),
        url
      };
    },
    httpFetch: async (url) => ({
      status: 200,
      text: "<html><head><title>detail</title></head><body>面经正文</body></html>",
      url
    })
  });

  const result = await adapter.searchAndFetch({
    query: "",
    maxArticles: 2,
    classifyTitles: async (titles) => titles.map((t) => !String(t).startsWith("noise"))
  });

  assert.equal(result.records.length, 2);
  assert.deepEqual(
    result.records.map((r) => r.sourceUrl),
    [
      "https://www.nowcoder.com/discuss/102",
      "https://www.nowcoder.com/discuss/104"
    ]
  );
  assert.equal(result.classifiedNo.length, 3);
  assert.equal(result.links.length, 2);
});

test("search mode uses pc/search JSON API for pagination instead of HTML page links", async () => {
  const searchCalls = [];
  const jsonFetch = async (url, { body } = {}) => {
    if (!url.includes("/api/sparta/pc/search")) {
      return { status: 404, text: "{}", url };
    }
    const payload = JSON.parse(body);
    searchCalls.push(payload.page);
    const records =
      payload.page === 1
        ? [
            {
              entityDataId: 123,
              data: { contentId: "123", momentData: { id: 123, title: "ByteDance MySQL interview" } }
            },
            {
              entityDataId: 456,
              data: { contentId: "456", momentData: { id: 456, title: "Meituan backend interview" } }
            }
          ]
        : [];
    return {
      status: 200,
      text: JSON.stringify({
        success: true,
        data: { records, totalPage: 3, total: 40, current: payload.page, size: 20 }
      }),
      url
    };
  };
  const httpFetch = async (url) => {
    if (url.includes("/discuss/123")) return { status: 200, text: ARTICLE_1, url };
    if (url.includes("/discuss/456")) return { status: 200, text: ARTICLE_2, url };
    return { status: 404, text: "", url };
  };
  const adapter = createNowCoderAdapter({ httpFetch, jsonFetch });

  const result = await adapter.searchAndFetch({ query: "mysql", maxArticles: 2 });

  assert.deepEqual(searchCalls, [1]);
  assert.equal(result.listSource, "search_api");
  assert.equal(result.records.length, 2);
  assert.equal(result.totalCandidates, 2);
});

test("feedJobIdFromUrl reads numeric tagId from the feed URL", () => {
  const adapter = createNowCoderAdapter({ httpFetch: async () => ({ status: 200, text: "" }) });
  assert.equal(adapter._internals.feedJobIdFromUrl(DEFAULT_FEED_URL), 639);
  assert.equal(
    adapter._internals.feedJobIdFromUrl("https://www.nowcoder.com/discuss/experience"),
    null
  );
});
