// API tests for POST /api/sources/nowcoder/fetch.
//
// The adapter is mocked — these tests verify:
// - successful adapter results reach the article store
// - adapter per-article failures surface in the response
// - adapter whole-pipeline failures produce a visible 4xx/5xx error

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";
import { ValidationError } from "../src/domain/errors.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-sources-"));
}

function mockAdapter(response) {
  return {
    searchAndFetch: async () => {
      if (response instanceof Error) throw response;
      return response;
    }
  };
}

test("POST /api/sources/nowcoder/fetch saves fetched articles and returns a summary", async () => {
  const baseDir = await makeBase();
  try {
    const adapter = mockAdapter({
      searchUrl: "https://www.nowcoder.com/search/all?query=mysql",
      links: [
        "https://www.nowcoder.com/discuss/1",
        "https://www.nowcoder.com/discuss/2"
      ],
      records: [
        {
          source: "nowcoder",
          sourceUrl: "https://www.nowcoder.com/discuss/1",
          query: "mysql",
          title: "字节二面 MySQL 面经",
          text: "面经正文 1",
          fetchedAt: "2026-05-05T10:00:00Z",
          rawMetadata: { interviewKeywords: ["面经"] }
        },
        {
          source: "nowcoder",
          sourceUrl: "https://www.nowcoder.com/discuss/2",
          query: "mysql",
          title: "美团 MySQL 面经",
          text: "面经正文 2",
          fetchedAt: "2026-05-05T10:00:00Z",
          rawMetadata: { interviewKeywords: ["面经"] }
        }
      ]
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sources/nowcoder/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql", maxArticles: 2 })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.saved.length, 2);
      assert.equal(body.failed.length, 0);
      assert.equal(body.discovered, 2);
      assert.equal(body.diagnostics.llmConfigured, false);
      assert.equal(body.diagnostics.extractionSkippedReason, "LLM_NOT_CONFIGURED");
      assert.equal(body.diagnostics.extractionAttempted, 0);
      assert.equal(body.diagnostics.articleTextStats.length, 2);
      for (const a of body.saved) {
        assert.equal(a.source, "nowcoder");
        assert.equal(a.query, "mysql");
        assert.match(a.id, /^nowcoder-mysql-/);
      }

      // The article store contains both records now.
      const list = await (
        await fetch(`${baseUrl}/api/articles?query=mysql`)
      ).json();
      assert.equal(list.articles.length, 2);
    }, { baseDir, nowCoderAdapter: adapter });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/sources/nowcoder/fetch reports extraction diagnostics when LLM is wired", async () => {
  const baseDir = await makeBase();
  try {
    const adapter = mockAdapter({
      searchUrl: "url",
      links: ["https://www.nowcoder.com/discuss/1", "https://www.nowcoder.com/discuss/2"],
      records: [
        {
          source: "nowcoder",
          sourceUrl: "https://www.nowcoder.com/discuss/1",
          query: "mysql",
          title: "MySQL 面经",
          text: "问了慢 SQL 怎么排查?",
          fetchedAt: "2026-05-05T10:00:00Z",
          rawMetadata: { interviewKeywords: ["面经"] }
        },
        {
          source: "nowcoder",
          sourceUrl: "https://www.nowcoder.com/discuss/2",
          query: "mysql",
          title: "求建议",
          text: "这是求建议帖子",
          fetchedAt: "2026-05-05T10:00:00Z",
          rawMetadata: { interviewKeywords: [] }
        }
      ]
    });
    const llmService = {
      classifyInterviewTitles: async () => ({ flags: [true, true], raw: "[]" }),
      extractQuestions: async ({ title }) => {
        if (title === "求建议") return { extraction: { isInterview: false, questions: [] } };
        return {
          extraction: {
            questions: [
              {
                question: "慢 SQL 怎么排查?",
                category: "MySQL",
                difficulty: "medium",
                confidence: 0.9
              }
            ]
          }
        };
      }
    };

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sources/nowcoder/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql" })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.savedArticles.length, 2);
      assert.equal(body.savedQuestions.length, 1);
      assert.equal(body.diagnostics.llmConfigured, true);
      assert.equal(body.diagnostics.extractionAttempted, 2);
      assert.equal(body.diagnostics.extractionSucceededArticles, 1);
      assert.equal(body.diagnostics.extractionNoQuestions, 1);
      assert.equal(body.diagnostics.extractionFailed, 0);
    }, { baseDir, nowCoderAdapter: adapter, llmService });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("per-article errors surface in the `failed` array without blocking saved records", async () => {
  const baseDir = await makeBase();
  try {
    const adapter = mockAdapter({
      searchUrl: "url",
      links: ["a", "b"],
      records: [
        {
          source: "nowcoder",
          sourceUrl: "https://www.nowcoder.com/discuss/good",
          query: "mysql",
          title: "好文章",
          text: "正文",
          fetchedAt: "2026-05-05T10:00:00Z",
          rawMetadata: { interviewKeywords: ["面经"] }
        },
        {
          __error: true,
          url: "https://www.nowcoder.com/discuss/bad",
          code: "NOWCODER_ARTICLE_FAILED",
          message: "HTTP 502"
        }
      ]
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sources/nowcoder/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql" })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.saved.length, 1);
      assert.equal(body.failed.length, 1);
      assert.equal(body.failed[0].code, "NOWCODER_ARTICLE_FAILED");
    }, { baseDir, nowCoderAdapter: adapter });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("adapter whole-pipeline failure surfaces as a 4xx with NOWCODER_FETCH_FAILED", async () => {
  const baseDir = await makeBase();
  try {
    const adapter = mockAdapter(
      new ValidationError("HTTP 500", { code: "NOWCODER_FETCH_FAILED", path: "status" })
    );
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sources/nowcoder/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql" })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "NOWCODER_FETCH_FAILED");
    }, { baseDir, nowCoderAdapter: adapter });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("rejects an unsafe query without calling the adapter", async () => {
  const baseDir = await makeBase();
  try {
    let called = false;
    const adapter = {
      searchAndFetch: async () => {
        called = true;
        return { searchUrl: "", links: [], records: [] };
      }
    };
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sources/nowcoder/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql;drop" })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "NOWCODER_INPUT_INVALID");
      assert.equal(called, false, "adapter must not be reached");
    }, { baseDir, nowCoderAdapter: adapter });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("re-fetching the same query passes existing sourceUrls to the adapter and reports them in `skipped`", async () => {
  const baseDir = await makeBase();
  try {
    // First call: returns one article; saved into the store.
    const articleA = {
      source: "nowcoder",
      sourceUrl: "https://www.nowcoder.com/discuss/A",
      query: "mysql",
      title: "字节",
      text: "正文 A",
      fetchedAt: "2026-05-05T10:00:00Z",
      rawMetadata: { interviewKeywords: [] }
    };
    const articleB = {
      source: "nowcoder",
      sourceUrl: "https://www.nowcoder.com/discuss/B",
      query: "mysql",
      title: "美团",
      text: "正文 B",
      fetchedAt: "2026-05-05T10:00:01Z",
      rawMetadata: { interviewKeywords: [] }
    };

    let observedExcludeUrls = null;
    const adapter = {
      searchAndFetch: async ({ excludeUrls = [] } = {}) => {
        observedExcludeUrls = [...excludeUrls];
        // The adapter under test would drop excluded URLs before fetching;
        // here we mimic that contract directly.
        const all = [articleA, articleB];
        const skipped = all
          .map((a) => a.sourceUrl)
          .filter((u) => excludeUrls.includes(u));
        const fresh = all.filter((a) => !excludeUrls.includes(a.sourceUrl));
        return {
          searchUrl: "url",
          links: fresh.map((a) => a.sourceUrl),
          skipped,
          records: fresh
        };
      }
    };

    await withServer(async (baseUrl) => {
      // First fetch: nothing excluded yet.
      const r1 = await fetch(`${baseUrl}/api/sources/nowcoder/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql" })
      });
      const b1 = await r1.json();
      assert.equal(b1.saved.length, 2);
      assert.deepEqual(b1.skipped, []);

      // Second fetch on same query: api must compute excludeUrls from
      // the article store and the adapter must report all existing
      // sourceUrls in `skipped`.
      const r2 = await fetch(`${baseUrl}/api/sources/nowcoder/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql" })
      });
      const b2 = await r2.json();

      assert.equal(b2.saved.length, 0, "no duplicate record was saved");
      assert.deepEqual(observedExcludeUrls.sort(), [
        "https://www.nowcoder.com/discuss/A",
        "https://www.nowcoder.com/discuss/B"
      ]);
      assert.deepEqual(b2.skipped.sort(), [
        "https://www.nowcoder.com/discuss/A",
        "https://www.nowcoder.com/discuss/B"
      ]);
    }, { baseDir, nowCoderAdapter: adapter });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
