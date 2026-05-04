// Step 4 e2e: practice-view question hydration + saving multiple answers
// for the same question.
//
// API correctness is covered by tests/api-attempts.test.js. These tests
// drive the front-end with a stubbed fetch so we can verify the user can
// in fact answer twice and see history render.

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function createApiSim() {
  const articles = [];
  const questions = [
    {
      id: "mysql-slow-sql-troubleshoot",
      question: "线上慢 SQL 怎么排查?",
      category: "MySQL",
      tags: ["MySQL"],
      difficulty: "medium",
      source: "manual",
      sourceUrl: null,
      sourceTitle: "字节二面整理",
      evidence: "面试官提到了慢日志",
      query: "mysql",
      confidence: 0.86,
      status: "candidate",
      createdAt: "2026-05-04",
      updatedAt: "2026-05-04"
    }
  ];
  const attempts = [];
  const calls = [];

  function fetch(url, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    calls.push({ method, url: String(url), body: options.body ?? null });
    const parsed = new URL(String(url), "http://127.0.0.1/");

    if (parsed.pathname === "/api/articles" && method === "GET") {
      const q = parsed.searchParams.get("query");
      const list = articles.filter((a) => a.query === q);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ articles: list }),
        text: () => Promise.resolve("")
      });
    }

    if (parsed.pathname === "/api/questions" && method === "GET") {
      const q = parsed.searchParams.get("query");
      const list = q ? questions.filter((x) => x.query === q) : questions.slice();
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            questions: list,
            meta: { total: questions.length, filtered: list.length, categories: [], statuses: [] }
          }),
        text: () => Promise.resolve("")
      });
    }

    if (parsed.pathname === "/api/attempts" && method === "GET") {
      const qid = parsed.searchParams.get("questionId");
      const list = attempts
        .filter((a) => a.questionId === qid)
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ attempts: list }),
        text: () => Promise.resolve("")
      });
    }

    if (parsed.pathname === "/api/attempts" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      if (!body.answer || !body.answer.trim()) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: "answer required", code: "ATTEMPT_INPUT_INVALID", path: "answer" }),
          text: () => Promise.resolve("")
        });
      }
      const record = {
        attemptId: `attempt-${Date.now()}-${attempts.length}`,
        questionId: body.questionId,
        answer: body.answer,
        // Use a strictly-increasing timestamp so sort order is deterministic
        // even when several saves happen inside one event loop tick.
        createdAt: new Date(Date.now() + attempts.length).toISOString(),
        status: "answered"
      };
      attempts.push(record);
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve(record),
        text: () => Promise.resolve("")
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "not found" }),
      text: () => Promise.resolve("")
    });
  }

  return { fetch, articles, questions, attempts, calls };
}

test("clicking a question card hydrates the practice hero with that question", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  const card = document.querySelector("[data-question-grid] [data-open-practice]");
  assert.ok(card, "first question card has a 开始练习 button");
  card.click();
  await flushDom(dom, 6);

  // Practice view is now visible and the hero shows the question text.
  assert.equal(document.querySelector('[data-view="practice"]').hidden, false);
  assert.match(document.querySelector("[data-question-title]").textContent, /慢 SQL/);
  assert.match(document.querySelector("[data-question-meta]").textContent, /MySQL/);
});

test("saving two answers for the same question populates history with two records", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  // Enter the practice view by clicking the first card's start button.
  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);

  // First answer.
  const input = document.querySelector("[data-answer-input]");
  input.value = "我先看慢查询日志,然后用 explain 看执行计划。";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);

  // Second answer.
  document.querySelector("[data-new-attempt]").click();
  input.value = "重答版:先确认范围,再分析执行计划,最后压测验证。";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);

  // Server received two POSTs.
  const posts = sim.calls.filter((c) => c.method === "POST" && c.url === "/api/attempts");
  assert.equal(posts.length, 2);
  assert.equal(sim.attempts.length, 2);
  assert.notEqual(sim.attempts[0].attemptId, sim.attempts[1].attemptId);

  // History panel renders two cards.
  const historyCards = document.querySelectorAll("[data-attempt-list] [data-attempt-id]");
  assert.equal(historyCards.length, 2);

  // Status banner shows success on the latest save.
  const status = document.querySelector("[data-attempt-status]");
  assert.equal(status.dataset.sourceStatusTone, "ok");
});

test("submitting an empty answer surfaces an inline error and does not POST", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);

  document.querySelector("[data-answer-input]").value = "   ";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 4);

  const posts = sim.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 0);
  const status = document.querySelector("[data-attempt-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /回答不能为空/);
});

test("clicking save without choosing a question first shows an error", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  // Switch to practice via top-nav (no question chosen).
  document.querySelector('[data-view-link="practice"]').click();
  await flushDom(dom, 4);

  // Type and save without first selecting a card.
  document.querySelector("[data-answer-input]").value = "这是回答内容";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 4);

  const status = document.querySelector("[data-attempt-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /选择/);
});

test("the practice view shows a placeholder when no attempts exist for the chosen question", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);

  const list = document.querySelector("[data-attempt-list]");
  assert.match(list.textContent, /还没有作答记录/);
});
