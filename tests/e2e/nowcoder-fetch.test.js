// Step 8 e2e: NowCoder fetch tab + failure-to-manual fallback path.
//
// Verifies:
// - the nowcoder tab reveals a fetch form
// - successful fetch shows the direct-to-question-pool status
// - when fetch fails the user can switch to the manual tab and still
//   save an article, preserving the manual rescue path

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function createSim({ nowCoderResponse }) {
  const articles = [];
  const calls = [];

  function ok(b, s = 200) {
    return Promise.resolve({
      ok: s < 400,
      status: s,
      json: () => Promise.resolve(b),
      text: () => Promise.resolve(JSON.stringify(b))
    });
  }

  function fetch(url, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    calls.push({ method, url: String(url), body: options.body ?? null });
    const parsed = new URL(String(url), "http://127.0.0.1/");

    if (parsed.pathname === "/api/articles" && method === "GET") {
      const q = parsed.searchParams.get("query");
      return ok({ articles: articles.filter((a) => a.query === q) });
    }
    if (parsed.pathname === "/api/questions" && method === "GET") {
      return ok({
        questions: [],
        meta: { total: 0, filtered: 0, categories: [], statuses: [] }
      });
    }
    if (parsed.pathname === "/api/articles/manual" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const record = {
        id: `manual-${articles.length}`,
        source: "manual",
        query: body.query,
        title: body.title,
        text: body.text,
        fetchedAt: new Date().toISOString()
      };
      articles.push(record);
      return ok(record, 201);
    }
    if (parsed.pathname === "/api/sources/nowcoder/fetch" && method === "POST") {
      if (nowCoderResponse.status >= 400) {
        return ok(nowCoderResponse.body, nowCoderResponse.status);
      }
      for (const a of nowCoderResponse.body.savedArticles ?? nowCoderResponse.body.saved ?? []) {
        articles.push(a);
      }
      return ok(nowCoderResponse.body);
    }
    return ok({ error: "not found" }, 404);
  }

  return { fetch, articles, calls };
}

test("clicking the 牛客 tab reveals the fetch form", async () => {
  const sim = createSim({
    nowCoderResponse: { status: 200, body: { saved: [], failed: [], discovered: 0, searchUrl: "" } }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="nowcoder"]').click();
  assert.equal(document.querySelector('[data-source-panel="nowcoder"]').hidden, false);
  assert.equal(document.querySelector("#nowcoder-fetch-form"), document.getElementById("nowcoder-fetch-form"));
});

test("successful fetch shows direct question-pool status", async () => {
  const saved = [
    {
      id: "nowcoder-mysql-1",
      source: "nowcoder",
      sourceUrl: "https://www.nowcoder.com/discuss/1",
      query: "mysql",
      title: "字节二面面经",
      text: "正文",
      fetchedAt: "2026-05-05T10:00:00Z"
    }
  ];
  const sim = createSim({
    nowCoderResponse: {
      status: 200,
      body: {
        savedArticles: saved,
        savedQuestions: [{ id: "mysql-q1" }],
        failed: [],
        discovered: 1,
        classifiedNo: 2,
        skippedUrls: [],
        searchUrl: "url"
      }
    }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="nowcoder"]').click();
  document.getElementById("nowcoder-fetch-form").requestSubmit();
  await flushDom(dom, 8);

  const status = document.querySelector('[data-source-panel="nowcoder"] [data-source-status]');
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /已新增 1 个问题/);
  assert.match(status.textContent, /抓 1 篇/);
  assert.match(status.textContent, /非面经 2/);
  assert.equal(document.querySelector("[data-imported-list]"), null);
});

test("fetch failure leaves the user free to use the manual paste tab", async () => {
  const sim = createSim({
    nowCoderResponse: {
      status: 400,
      body: { error: "HTTP 500", code: "NOWCODER_FETCH_FAILED", path: "status" }
    }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  // 1. nowcoder fetch fails
  document.querySelector('[data-source-tab="nowcoder"]').click();
  document.getElementById("nowcoder-fetch-form").requestSubmit();
  await flushDom(dom, 8);
  const failStatus = document.querySelector(
    '[data-source-panel="nowcoder"] [data-source-status]'
  );
  assert.equal(failStatus.dataset.sourceStatusTone, "error");
  assert.match(failStatus.textContent, /抓取失败/);

  // 2. user switches to manual tab and saves an article, the rescue path
  document.querySelector('[data-source-tab="manual"]').click();
  const manualForm = document.getElementById("manual-import-form");
  manualForm.querySelector("[name=query]").value = "mysql";
  manualForm.querySelector("[name=title]").value = "手动 MySQL 面经";
  manualForm.querySelector("[name=text]").value = "面经正文...";
  manualForm.requestSubmit();
  await flushDom(dom, 8);

  // The article store now contains the manually-pasted record.
  assert.equal(sim.articles.length, 1);
  assert.equal(sim.articles[0].source, "manual");

  const okStatus = document.querySelector(
    '[data-source-panel="manual"] [data-source-status]'
  );
  assert.equal(okStatus.dataset.sourceStatusTone, "ok");
  assert.match(okStatus.textContent, /已保存/);
});
