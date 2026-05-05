// E2E for the imported-articles list:
// - clicking an article opens a preview
// - the preview's "用此文章调用 LLM 抽题" button hits /api/questions/extract
// - re-fetching from NowCoder for the same query reports `skipped` and
//   does not duplicate the entry

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function buildSim({ articles = [], extractAdded = [], skipped = [] } = {}) {
  const calls = [];
  const ok = (b, s = 200) =>
    Promise.resolve({
      ok: s < 400,
      status: s,
      json: () => Promise.resolve(b),
      text: () => Promise.resolve(JSON.stringify(b))
    });

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
    if (parsed.pathname === "/api/questions/extract" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      // Echo the articleId in the response so tests can verify which
      // article was used.
      return ok({
        added: extractAdded.map((q) => ({ ...q, query: body.query })),
        duplicates: [],
        errors: [],
        usedArticleId: body.articleId ?? null
      });
    }
    if (parsed.pathname === "/api/sources/nowcoder/fetch" && method === "POST") {
      // Pretend the server already deduped against the store and reports
      // skipped URLs.
      return ok({
        searchUrl: "url",
        discovered: skipped.length,
        saved: [],
        skipped,
        failed: []
      });
    }
    return ok({ error: "not found" }, 404);
  }
  return { fetch, articles, calls };
}

const sampleNowCoderArticle = {
  id: "nowcoder-mysql-001",
  source: "nowcoder",
  sourceUrl: "https://www.nowcoder.com/discuss/123",
  query: "mysql",
  title: "字节二面 MySQL 面经",
  text: "面试官问了 InnoDB 的 ACID...",
  fetchedAt: "2026-05-05T10:00:00Z"
};

const sampleManualArticle = {
  id: "manual-mysql-002",
  source: "manual",
  query: "mysql",
  title: "手动粘贴的 MySQL 面经",
  text: "面试官:索引失效有哪些情况?\n候选人:...",
  fetchedAt: "2026-05-05T11:00:00Z"
};

test("clicking an imported article opens the preview with title + meta + body", async () => {
  const sim = buildSim({ articles: [sampleNowCoderArticle, sampleManualArticle] });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  // Both items rendered.
  const items = document.querySelectorAll(
    "[data-imported-list] li[data-imported-id]"
  );
  assert.equal(items.length, 2);

  // Click the nowcoder one (first in newest-first order).
  const target = Array.from(items).find(
    (li) => li.dataset.importedId === sampleNowCoderArticle.id
  );
  target.click();
  await flushDom(dom, 4);

  const panel = document.querySelector("[data-article-preview]");
  assert.equal(panel.hidden, false, "preview panel becomes visible");
  assert.match(
    document.querySelector("[data-article-preview-title]").textContent,
    /字节二面 MySQL 面经/
  );
  assert.match(
    document.querySelector("[data-article-preview-meta]").textContent,
    /牛客抓取/
  );
  const link = document.querySelector("[data-article-preview-link]");
  assert.equal(link.hidden, false);
  assert.equal(link.getAttribute("href"), sampleNowCoderArticle.sourceUrl);
  assert.match(
    document.querySelector("[data-article-preview-body]").textContent,
    /InnoDB/
  );
  // The clicked li is highlighted.
  assert.equal(target.classList.contains("active"), true);
});

test("manual articles open in the preview without the 牛客原文 link", async () => {
  const sim = buildSim({ articles: [sampleManualArticle] });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  document
    .querySelector(`[data-imported-list] li[data-imported-id="${sampleManualArticle.id}"]`)
    .click();
  await flushDom(dom, 4);

  assert.equal(document.querySelector("[data-article-preview]").hidden, false);
  assert.equal(
    document.querySelector("[data-article-preview-link]").hidden,
    true,
    "manual articles without sourceUrl have no link"
  );
});

test('"用此文章调用 LLM 抽题" POSTs /api/questions/extract with the article id', async () => {
  const sim = buildSim({
    articles: [sampleNowCoderArticle],
    extractAdded: [
      {
        id: "mysql-q1",
        question: "线上慢 SQL 怎么排查?",
        category: "MySQL",
        difficulty: "medium",
        confidence: 0.86,
        evidence: "evidence",
        status: "candidate"
      }
    ]
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  document
    .querySelector(`[data-imported-list] li[data-imported-id="${sampleNowCoderArticle.id}"]`)
    .click();
  await flushDom(dom, 4);
  document.querySelector("[data-article-preview-extract]").click();
  await flushDom(dom, 8);

  const extractPosts = sim.calls.filter(
    (c) => c.method === "POST" && c.url === "/api/questions/extract"
  );
  assert.equal(extractPosts.length, 1);
  const sent = JSON.parse(extractPosts[0].body);
  assert.equal(sent.articleId, sampleNowCoderArticle.id);
  assert.equal(sent.query, "mysql");

  const status = document.querySelector("[data-article-preview-status]");
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /已抽 1 条/);
});

test('extract failure shows "可改用 \\"导入抽题\\" 粘贴 JSON" hint', async () => {
  const dom = await buildAppDom({
    fetch: (url, options = {}) => {
      const method = (options.method ?? "GET").toUpperCase();
      const parsed = new URL(String(url), "http://127.0.0.1/");
      if (parsed.pathname === "/api/articles" && method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ articles: [sampleNowCoderArticle] }),
          text: () => Promise.resolve("")
        });
      }
      if (parsed.pathname === "/api/questions" && method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              questions: [],
              meta: { total: 0, filtered: 0, categories: [], statuses: [] }
            }),
          text: () => Promise.resolve("")
        });
      }
      if (parsed.pathname === "/api/questions/extract" && method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({
              error: "LLM_NOT_CONFIGURED",
              code: "LLM_NOT_CONFIGURED",
              path: "service"
            }),
          text: () => Promise.resolve("")
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("")
      });
    }
  });
  await flushDom(dom, 6);
  const { document } = dom.window;

  document
    .querySelector(`[data-imported-list] li[data-imported-id="${sampleNowCoderArticle.id}"]`)
    .click();
  await flushDom(dom, 4);
  document.querySelector("[data-article-preview-extract]").click();
  await flushDom(dom, 6);

  const status = document.querySelector("[data-article-preview-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /可改用/);
});

test("nowcoder fetch shows '跳过 N 篇旧文章' when the server reports skipped urls", async () => {
  const sim = buildSim({
    articles: [sampleNowCoderArticle],
    skipped: [sampleNowCoderArticle.sourceUrl]
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 4);
  const { document } = dom.window;

  document.querySelector('[data-source-tab="nowcoder"]').click();
  document.getElementById("nowcoder-fetch-form").requestSubmit();
  await flushDom(dom, 6);

  const status = document.querySelector(
    '[data-source-panel="nowcoder"] [data-source-status]'
  );
  assert.match(status.textContent, /跳过 1 篇旧文章/);
});

test("clicking the X close button hides the preview and clears highlight", async () => {
  const sim = buildSim({ articles: [sampleNowCoderArticle] });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  document
    .querySelector(`[data-imported-list] li[data-imported-id="${sampleNowCoderArticle.id}"]`)
    .click();
  await flushDom(dom, 4);
  assert.equal(document.querySelector("[data-article-preview]").hidden, false);

  document.querySelector("[data-article-preview-close]").click();
  assert.equal(document.querySelector("[data-article-preview]").hidden, true);
  // Highlight cleared.
  assert.equal(
    document
      .querySelector(`[data-imported-list] li[data-imported-id="${sampleNowCoderArticle.id}"]`)
      .classList.contains("active"),
    false
  );
});
