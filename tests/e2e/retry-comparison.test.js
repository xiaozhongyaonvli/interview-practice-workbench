// Step 6 e2e: two answers + two scores → best attempt is the higher-scoring
// one and the history shows the score delta between attempts.

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function summary(scores, gaps = "...") {
  return {
    scores,
    overallComment: "comment",
    primaryTechnicalGap: gaps,
    primaryExpressionGap: gaps,
    engineeringMindsetGap: gaps,
    retryInstruction: gaps
  };
}

const lowSummary = summary({
  technicalCorrectness: 5,
  coverageCompleteness: 5,
  logicalStructure: 5,
  expressionClarity: 5,
  interviewPerformance: 5
});

const highSummary = summary({
  technicalCorrectness: 8,
  coverageCompleteness: 7,
  logicalStructure: 8,
  expressionClarity: 7,
  interviewPerformance: 7
});

function createSim() {
  const questions = [
    {
      id: "mysql-q1",
      question: "Q1?",
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
      const result = list.map((a) => {
        const latest = scores
          .filter((s) => s.attemptId === a.attemptId)
          .sort((x, y) => x.scoredAt.localeCompare(y.scoredAt))
          .pop();
        return latest
          ? {
              ...a,
              status: "scored",
              summary: latest.summary,
              feedback: null,
              scoredAt: latest.scoredAt
            }
          : a;
      });
      return ok({ attempts: result });
    }

    if (parsed.pathname === "/api/attempts" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const record = {
        attemptId: `attempt-${attempts.length}`,
        questionId: body.questionId,
        answer: body.answer,
        // Strictly increasing timestamps so order is deterministic.
        createdAt: new Date(Date.now() + attempts.length * 1000).toISOString(),
        status: "answered"
      };
      attempts.push(record);
      return ok(record, 201);
    }

    const scoreMatch = parsed.pathname.match(
      /^\/api\/attempts\/([A-Za-z0-9_-]+)\/score$/
    );
    if (scoreMatch && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const summary = body.summary ?? JSON.parse(body.rawResponse);
      const record = {
        attemptId: scoreMatch[1],
        scoredAt: new Date(Date.now() + scores.length * 1000 + 5000).toISOString(),
        feedbackPromptVersion: "interview-coach-v2",
        summary,
        feedback: null
      };
      scores.push(record);
      return ok(record, 201);
    }

    return ok({ error: "not found" }, 404);
  }

  return { fetch, attempts, scores };
}

async function answerAndScore(dom, document, answer, summaryToUse) {
  // Save attempt
  document.querySelector("[data-new-attempt]").click();
  document.querySelector("[data-answer-input]").value = answer;
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);

  // Open scoring panel + paste summary + submit
  document.querySelector("[data-toggle-score]").click();
  document.getElementById("score-input-form").querySelector("[name=rawResponse]").value =
    JSON.stringify(summaryToUse);
  document.getElementById("score-input-form").requestSubmit();
  await flushDom(dom, 8);
}

test("two answers + two scores → history shows both, best badge sits on the higher-scoring attempt, delta is visible", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);

  await answerAndScore(dom, document, "first answer (weak)", lowSummary);
  await answerAndScore(dom, document, "second answer (strong)", highSummary);

  // Two attempts present.
  const cards = document.querySelectorAll("[data-attempt-list] [data-attempt-id]");
  assert.equal(cards.length, 2);

  // Best badge is on exactly one card.
  const bestBadges = document.querySelectorAll("[data-attempt-list] [data-best-attempt]");
  assert.equal(bestBadges.length, 1);

  // The newest card (second attempt, higher score) should be the best.
  const newestCard = cards[0];
  assert.ok(
    newestCard.querySelector("[data-best-attempt]"),
    "the best badge sits on the newest+highest attempt"
  );

  // Delta on the newest card shows ↑ (higher than previous).
  const newestSpan = newestCard.querySelector("span").textContent;
  assert.match(newestSpan, /↑/);

  // Total label uses one decimal.
  assert.match(newestSpan, /7\.4 \/ 10/);
  const olderSpan = cards[1].querySelector("span").textContent;
  assert.match(olderSpan, /5\.0 \/ 10/);
});

test("when only one attempt is scored, that attempt is best and delta is not shown", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);

  await answerAndScore(dom, document, "the only answer", lowSummary);

  const cards = document.querySelectorAll("[data-attempt-list] [data-attempt-id]");
  assert.equal(cards.length, 1);

  const bestBadges = document.querySelectorAll("[data-attempt-list] [data-best-attempt]");
  assert.equal(bestBadges.length, 1);
  // No previous attempt → no delta.
  assert.doesNotMatch(cards[0].querySelector("span").textContent, /↑|↓/);
});

test("a regressing rescore (lower second score) shows ↓", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);

  await answerAndScore(dom, document, "first attempt (good)", highSummary);
  await answerAndScore(dom, document, "second attempt (worse)", lowSummary);

  const cards = document.querySelectorAll("[data-attempt-list] [data-attempt-id]");
  // newest (second) has lower score → delta should be ↓
  assert.match(cards[0].querySelector("span").textContent, /↓/);

  // Best badge sits on the older, higher-scoring attempt.
  assert.ok(cards[1].querySelector("[data-best-attempt]"));
});
