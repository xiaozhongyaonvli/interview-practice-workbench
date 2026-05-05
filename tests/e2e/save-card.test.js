// Step 7 e2e: promote a scored attempt into a CardRecord.
//
// Verifies:
// - save button starts disabled
// - pasting a valid score unlocks it
// - submit posts to /api/cards/from-attempt and shows success

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

const summary = {
  scores: {
    technicalCorrectness: 8,
    coverageCompleteness: 7,
    logicalStructure: 8,
    expressionClarity: 7,
    interviewPerformance: 7
  },
  overallComment: "良好",
  primaryTechnicalGap: "...",
  primaryExpressionGap: "...",
  engineeringMindsetGap: "...",
  retryInstruction: "..."
};

function createSim() {
  const questions = [
    {
      id: "mysql-q1",
      question: "慢 SQL 怎么排查?",
      category: "MySQL",
      tags: ["MySQL"],
      difficulty: "medium",
      source: "manual",
      sourceUrl: null,
      sourceTitle: null,
      evidence: null,
      query: "mysql",
      confidence: 0.85,
      status: "candidate",
      createdAt: "2026-05-04",
      updatedAt: "2026-05-04"
    }
  ];
  const attempts = [];
  const scores = [];
  const cards = [];
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
      return ok({ articles: [] });
    }
    if (parsed.pathname === "/api/questions" && method === "GET") {
      return ok({
        questions,
        meta: { total: 1, filtered: 1, categories: [], statuses: [] }
      });
    }
    if (parsed.pathname === "/api/attempts" && method === "GET") {
      const qid = parsed.searchParams.get("questionId");
      const list = attempts
        .filter((a) => a.questionId === qid)
        .slice()
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
      const withScores = list.map((a) => {
        const latest = scores
          .filter((s) => s.attemptId === a.attemptId)
          .sort((x, y) => x.scoredAt.localeCompare(y.scoredAt))
          .pop();
        return latest
          ? { ...a, status: "scored", summary: latest.summary, feedback: null, scoredAt: latest.scoredAt }
          : a;
      });
      return ok({ attempts: withScores });
    }
    if (parsed.pathname === "/api/attempts" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const r = {
        attemptId: `attempt-${attempts.length}`,
        questionId: body.questionId,
        answer: body.answer,
        createdAt: new Date(Date.now() + attempts.length * 1000).toISOString(),
        status: "answered"
      };
      attempts.push(r);
      return ok(r, 201);
    }
    const scoreMatch = parsed.pathname.match(/^\/api\/attempts\/([A-Za-z0-9_-]+)\/score$/);
    if (scoreMatch && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const parsedSummary = body.summary ?? JSON.parse(body.rawResponse);
      const r = {
        attemptId: scoreMatch[1],
        scoredAt: new Date().toISOString(),
        feedbackPromptVersion: "interview-coach-v2",
        summary: parsedSummary,
        feedback: null
      };
      scores.push(r);
      return ok(r, 201);
    }
    if (parsed.pathname === "/api/cards/from-attempt" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const existing = cards.find((c) => c.id === "mysql-q1");
      if (existing && !body.overwrite) {
        return ok(
          { error: "duplicate", code: "CARD_DUPLICATE_ID", path: "cardId" },
          400
        );
      }
      const question = questions[0];
      const attempt = attempts.find((a) => a.attemptId === body.attemptId);
      const scoreRec = scores.filter((s) => s.attemptId === body.attemptId).pop();
      const card = {
        id: question.id,
        title: question.question,
        count: 0,
        category: body.category,
        tags: [body.category],
        difficulty: body.difficulty,
        createdAt: "2026-05-04",
        updatedAt: "2026-05-04",
        question: question.question,
        myAnswer: attempt.answer,
        feedbackPromptVersion: "interview-coach-v2",
        feedback: {
          performanceScore: {
            scores: scoreRec.summary.scores,
            overallComment: scoreRec.summary.overallComment
          }
        }
      };
      const idx = cards.findIndex((c) => c.id === card.id);
      if (idx >= 0) cards[idx] = card;
      else cards.push(card);
      return ok(card, 201);
    }
    if (parsed.pathname === "/api/cards" && method === "GET") {
      return ok({ cards });
    }
    return ok({ error: "not found" }, 404);
  }

  return { fetch, attempts, scores, cards, calls };
}

test("save-card button is disabled until a scored attempt exists", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  // Enter practice for the question.
  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);

  const btn = document.querySelector("[data-save-card-btn]");
  assert.equal(btn.disabled, true, "save button is disabled without any attempt");

  // Save an attempt — still no score, still disabled.
  document.querySelector("[data-answer-input]").value = "first answer";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);
  assert.equal(btn.disabled, true, "save button remains disabled without a score");

  // Paste a valid score — now unlocks.
  document.querySelector("[data-toggle-score]").click();
  document.getElementById("score-input-form").querySelector("[name=rawResponse]").value = JSON.stringify(summary);
  document.getElementById("score-input-form").requestSubmit();
  await flushDom(dom, 8);

  assert.equal(btn.disabled, false, "save button unlocked after scoring");
  const check = document.querySelector("[data-save-check-score]");
  assert.equal(check.className, "ok");
  assert.match(check.textContent, /7\.4/);
});

test("submitting the save-card form POSTs to /api/cards/from-attempt and shows success", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);

  document.querySelector("[data-answer-input]").value = "answer";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-toggle-score]").click();
  document.getElementById("score-input-form").querySelector("[name=rawResponse]").value = JSON.stringify(summary);
  document.getElementById("score-input-form").requestSubmit();
  await flushDom(dom, 8);

  // Adjust difficulty to 困难 and submit.
  document.querySelector("[data-save-difficulty]").value = "hard";
  document.querySelector("[data-save-card-form]").requestSubmit();
  await flushDom(dom, 6);

  const posts = sim.calls.filter(
    (c) => c.method === "POST" && c.url === "/api/cards/from-attempt"
  );
  assert.equal(posts.length, 1);
  const sent = JSON.parse(posts[0].body);
  assert.equal(sent.category, "MySQL");
  assert.equal(sent.difficulty, "hard");
  assert.equal(sent.overwrite, false);

  assert.equal(sim.cards.length, 1);
  assert.equal(sim.cards[0].difficulty, "hard");

  const status = document.querySelector("[data-save-status]");
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /已保存卡片/);
});

test("on duplicate-id rejection, user confirms overwrite and a second POST with overwrite=true succeeds", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  // Stub window.confirm to always say yes so the overwrite flow exercises.
  dom.window.confirm = () => true;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "a";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-toggle-score]").click();
  document.getElementById("score-input-form").querySelector("[name=rawResponse]").value = JSON.stringify(summary);
  document.getElementById("score-input-form").requestSubmit();
  await flushDom(dom, 8);

  // First save succeeds.
  document.querySelector("[data-save-card-form]").requestSubmit();
  await flushDom(dom, 6);
  assert.equal(sim.cards.length, 1);

  // Second save hits CARD_DUPLICATE_ID, user confirms, retry w/ overwrite.
  document.querySelector("[data-save-card-form]").requestSubmit();
  await flushDom(dom, 8);

  const posts = sim.calls.filter(
    (c) => c.method === "POST" && c.url === "/api/cards/from-attempt"
  );
  // 3 total: success, dup, overwrite-retry.
  assert.equal(posts.length, 3);
  assert.equal(JSON.parse(posts[2].body).overwrite, true);

  const status = document.querySelector("[data-save-status]");
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /覆盖保存/);
});
