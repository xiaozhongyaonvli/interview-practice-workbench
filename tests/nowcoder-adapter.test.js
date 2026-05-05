// Unit tests for the NowCoder adapter.
// The real HTTP layer is mocked via an injectable httpFetch so these tests
// never hit the network.

import assert from "node:assert/strict";
import test from "node:test";
import { createNowCoderAdapter } from "../src/sources/nowcoderAdapter.js";
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

const SEARCH_HTML_BASE = `<!doctype html>
<html><head><title>搜索</title></head><body>
<a href="/discuss/123">字节二面 MySQL 面经,问到索引和事务</a>
<a href="/discuss/456">美团后端社招 面经,MySQL 锁和主从</a>
<a href="https://other.com/x">external link,ignored</a>
<a href="/some/unrelated/path">unrelated path,ignored</a>
</body></html>`;

const ARTICLE_1 = `<!doctype html>
<html><head><title>字节二面 MySQL 面经</title></head>
<body><h1>字节二面</h1>
<p>问了 MySQL 的 ACID 怎么保证,索引失效的情况...</p>
<script>window.__INITIAL_STATE__ = {}</script>
</body></html>`;

const ARTICLE_2 = `<!doctype html>
<html><head><title>美团社招面经</title></head>
<body><p>主从延迟如何排查,锁等待。</p></body></html>`;

test("searchAndFetch returns ArticleRecord-shaped objects for discovered links", async () => {
  const { httpFetch } = mockFetchByUrl({
    "https://www.nowcoder.com/search/all?query=mysql&type=all&searchType=%E9%A1%B6%E9%83%A8%E5%AF%BC%E8%88%AA%E6%A0%8F":
      SEARCH_HTML_BASE,
    "https://www.nowcoder.com/discuss/123": ARTICLE_1,
    "https://www.nowcoder.com/discuss/456": ARTICLE_2
  });
  const adapter = createNowCoderAdapter({
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

test("rejects a search-page HTTP failure with a visible error", async () => {
  const httpFetch = async () => ({ status: 500, text: "server error" });
  const adapter = createNowCoderAdapter({ httpFetch });
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
    if (url.endsWith("/discuss/123"))
      return { status: 200, text: ARTICLE_1 };
    if (url.endsWith("/discuss/456"))
      return { status: 502, text: "bad gateway" };
    return { status: 404, text: "" };
  };
  const adapter = createNowCoderAdapter({ httpFetch });

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
      // 5 article links; adapter should only follow the first 2.
      const links = Array.from({ length: 5 }, (_, i) =>
        `<a href="/discuss/${100 + i}">面经 #${i}</a>`
      ).join("\n");
      return { status: 200, text: `<html><body>${links}</body></html>` };
    }
    return { status: 200, text: `<html><title>t</title><body>面经</body></html>` };
  };
  const sleeps = [];
  const adapter = createNowCoderAdapter({
    httpFetch,
    delayMs: 7,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    }
  });

  const result = await adapter.searchAndFetch({ query: "mysql", maxArticles: 2 });
  assert.equal(result.records.length, 2);
  // sleep called once between the two article fetches.
  assert.deepEqual(sleeps, [7]);
});

test("toArticleRecord strips script/style and preserves title", async () => {
  const adapter = createNowCoderAdapter({
    httpFetch: async () => ({ status: 200, text: "" }),
    now: () => "T"
  });
  const record = adapter._internals.toArticleRecord({
    url: "https://www.nowcoder.com/discuss/1",
    html:
      "<html><head><title>字节 MySQL 面经</title></head><body>" +
      "<script>bad()</script><p>问题 1: ACID</p>" +
      "<style>.x{color:red}</style>" +
      "</body></html>",
    query: "mysql"
  });
  assert.equal(record.source, "nowcoder");
  assert.equal(record.title, "字节 MySQL 面经");
  assert.match(record.text, /ACID/);
  assert.doesNotMatch(record.text, /bad\(\)/);
  assert.doesNotMatch(record.text, /color:red/);
});

test("discoverArticleLinks deduplicates trailing query strings", () => {
  const adapter = createNowCoderAdapter({ httpFetch: async () => ({ status: 200, text: "" }) });
  const links = adapter._internals.discoverArticleLinks(
    `<a href="/discuss/1?ref=a">x</a>
     <a href="/discuss/1?ref=b">y</a>
     <a href="/discuss/2#top">z</a>`,
    "https://www.nowcoder.com/search"
  );
  assert.equal(links.length, 2);
  assert.ok(links.includes("https://www.nowcoder.com/discuss/1"));
  assert.ok(links.includes("https://www.nowcoder.com/discuss/2"));
});
