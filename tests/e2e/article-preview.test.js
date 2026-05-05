// Feed refactor regression tests:
// - imported article list and article preview UI are intentionally gone
// - NowCoder fetch updates the question pool directly
// - duplicate/skipped URLs are reported in the source status

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function ok(body, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  });
}

function buildSim({ fetchBody, questionsAfterFetch = [] } = {}) {
  const calls = [];
  let fetched = false;

  function fetch(url, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    calls.push({ method, url: String(url), body: options.body ?? null });
    const parsed = new URL(String(url), "http://127.0.0.1/");

    if (parsed.pathname === "/api/questions" && method === "GET") {
      return ok({
        questions: fetched ? questionsAfterFetch : [],
        meta: { total: fetched ? questionsAfterFetch.length : 0 }
      });
    }
    if (parsed.pathname === "/api/attempts" && method === "GET") {
      return ok({ attempts: [] });
    }
    if (parsed.pathname === "/api/sources/nowcoder/fetch" && method === "POST") {
      fetched = true;
      return ok(
        fetchBody ?? {
          mode: "search",
          discovered: 1,
          savedArticles: [],
          savedQuestions: [],
          skippedUrls: [],
          failed: [],
          classifiedNo: 0,
          prunedArticles: 0
        }
      );
    }
    return ok({ error: "not found" }, 404);
  }

  return { fetch, calls };
}

test("article list and article preview UI are not present", async () => {
  const sim = buildSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  assert.equal(document.querySelector("[data-imported-list]"), null);
  assert.equal(document.querySelector("[data-article-preview]"), null);
  assert.equal(document.querySelector("[data-article-modal]"), null);
  assert.equal(document.querySelector("[data-article-preview-extract]"), null);
});

test("nowcoder fetch refreshes the question pool directly", async () => {
  const sim = buildSim({
    fetchBody: {
      mode: "search",
      discovered: 1,
      savedArticles: [{ id: "a1" }],
      savedQuestions: [{ id: "mysql-q1" }],
      skippedUrls: [],
      failed: [],
      classifiedNo: 0,
      prunedArticles: 0
    },
    questionsAfterFetch: [
      {
        id: "mysql-q1",
        question: "MySQL index invalidation cases?",
        category: "MySQL",
        tags: ["MySQL"],
        difficulty: "medium",
        confidence: 0.9,
        source: "nowcoder",
        evidence: "index invalidation",
        status: "candidate"
      }
    ]
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="nowcoder"]').click();
  document.getElementById("nowcoder-fetch-form").requestSubmit();
  await flushDom(dom, 8);

  const status = document.querySelector(
    '[data-source-panel="nowcoder"] [data-source-status]'
  );
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /已新增 1 个问题/);
  assert.match(status.textContent, /抓 1 篇/);

  const cards = Array.from(document.querySelectorAll("[data-question-id] h4")).map(
    (node) => node.textContent
  );
  assert.deepEqual(cards, ["MySQL index invalidation cases?"]);
});

test("nowcoder fetch reports skipped URLs without rendering articles", async () => {
  const sim = buildSim({
    fetchBody: {
      mode: "search",
      discovered: 1,
      savedArticles: [],
      savedQuestions: [],
      skippedUrls: ["https://www.nowcoder.com/discuss/1"],
      failed: [],
      classifiedNo: 0,
      prunedArticles: 0
    }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="nowcoder"]').click();
  document.getElementById("nowcoder-fetch-form").requestSubmit();
  await flushDom(dom, 8);

  const status = document.querySelector(
    '[data-source-panel="nowcoder"] [data-source-status]'
  );
  assert.match(status.textContent, /跳过旧链接 1/);
  assert.equal(document.querySelector("[data-imported-list]"), null);
});
