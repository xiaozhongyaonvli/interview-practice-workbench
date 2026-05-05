// Step 9 e2e: frontend LLM scoring hooks.
//
// The old "call LLM extraction from an article preview" UI was removed in the
// feed refactor. Extraction now happens inside /api/sources/nowcoder/fetch,
// while this page keeps the manual JSON import rescue lane and LLM scoring.

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function buildSim({ llmScoreResp }) {
  const questions = [];
  const attempts = [];
  const scores = [];
  const calls = [];

  function ok(body, status = 200) {
    return Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body))
    });
  }

  function fetch(url, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    calls.push({ method, url: String(url), body: options.body ?? null });
    const parsed = new URL(String(url), "http://127.0.0.1/");

    if (parsed.pathname === "/api/questions" && method === "GET") {
      const q = parsed.searchParams.get("query");
      const list = q ? questions.filter((x) => x.query === q) : questions.slice();
      return ok({
        questions: list,
        meta: { total: questions.length, filtered: list.length, categories: [], statuses: [] }
      });
    }
    if (parsed.pathname === "/api/questions/import" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const parsedBody = JSON.parse(body.rawResponse);
      const added = parsedBody.questions.map((q, i) => ({
        id: `pasted-${questions.length + i}`,
        question: q.question,
        category: q.category,
        tags: [q.category],
        difficulty: q.difficulty,
        source: "manual",
        sourceUrl: null,
        sourceTitle: null,
        evidence: q.evidence ?? null,
        query: body.query,
        confidence: q.confidence,
        status: "candidate",
        createdAt: "2026-05-04",
        updatedAt: "2026-05-04"
      }));
      for (const q of added) questions.push(q);
      return ok({ added, duplicates: [], errors: [] });
    }
    if (parsed.pathname === "/api/attempts" && method === "GET") {
      const qid = parsed.searchParams.get("questionId");
      const list = attempts.filter((a) => a.questionId === qid).slice();
      const merged = list.map((a) => {
        const latest = scores.filter((s) => s.attemptId === a.attemptId).pop();
        return latest
          ? { ...a, status: "scored", summary: latest.summary, feedback: null }
          : a;
      });
      return ok({ attempts: merged });
    }
    if (parsed.pathname === "/api/attempts" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const record = {
        attemptId: `attempt-${attempts.length}`,
        questionId: body.questionId,
        answer: body.answer,
        createdAt: new Date(Date.now() + attempts.length * 1000).toISOString(),
        status: "answered"
      };
      attempts.push(record);
      return ok(record, 201);
    }

    const llmScoreMatch = parsed.pathname.match(
      /^\/api\/attempts\/([A-Za-z0-9_-]+)\/llm-score$/
    );
    if (llmScoreMatch && method === "POST") {
      if (llmScoreResp.status >= 400) return ok(llmScoreResp.body, llmScoreResp.status);
      scores.push({
        attemptId: llmScoreMatch[1],
        scoredAt: new Date().toISOString(),
        feedbackPromptVersion: "interview-coach-v2",
        summary: llmScoreResp.body.summary,
        feedback: null
      });
      return ok(llmScoreResp.body, 201);
    }

    return ok({ error: "not found" }, 404);
  }

  return { fetch, questions, attempts, scores, calls };
}

const validSummary = {
  scores: {
    technicalCorrectness: 7,
    coverageCompleteness: 6,
    logicalStructure: 7,
    expressionClarity: 7,
    interviewPerformance: 6
  },
  overallComment: "acceptable",
  primaryTechnicalGap: "missing lock wait details",
  primaryExpressionGap: "structure is loose",
  engineeringMindsetGap: "missing verification loop",
  retryInstruction: "answer by discovery, location, analysis, verification"
};

async function seedQuestionByManualJson(dom, document) {
  document.querySelector('[data-source-tab="extract"]').click();
  const form = document.getElementById("extract-import-form");
  form.querySelector("[name=query]").value = "mysql";
  form.querySelector("[name=rawResponse]").value = JSON.stringify({
    questions: [
      {
        question: "How do you diagnose slow SQL online?",
        category: "MySQL",
        difficulty: "medium",
        confidence: 0.86,
        evidence: "slow SQL"
      }
    ]
  });
  form.requestSubmit();
  await flushDom(dom, 8);
}

async function openQuestionAndSaveAttempt(dom, document) {
  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "my answer";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);
}

test("LLM score success renders feedback card", async () => {
  const sim = buildSim({
    llmScoreResp: { status: 201, body: { summary: validSummary, attemptId: "x" } }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  await seedQuestionByManualJson(dom, document);
  await openQuestionAndSaveAttempt(dom, document);

  document.querySelector("[data-llm-score]").click();
  await flushDom(dom, 8);

  assert.equal(document.querySelector("[data-big-score]").textContent, "6.6");
  const status = document.querySelector("[data-attempt-status]");
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /LLM 评分通过校验/);
});

test("LLM score failure leaves attempt intact and the user can still paste JSON", async () => {
  const sim = buildSim({
    llmScoreResp: {
      status: 400,
      body: { error: "model timed out", code: "LLM_CALL_FAILED", path: "chatComplete" }
    }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  await seedQuestionByManualJson(dom, document);
  await openQuestionAndSaveAttempt(dom, document);

  document.querySelector("[data-llm-score]").click();
  await flushDom(dom, 8);

  const status = document.querySelector("[data-attempt-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /可改用粘贴 JSON/);
  assert.equal(sim.attempts.length, 1);
  assert.equal(sim.scores.length, 0);
});
