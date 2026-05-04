// Step 5 e2e: pasting an LLM scoring JSON renders the feedback card.

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

const validSummary = {
  scores: {
    technicalCorrectness: 7,
    coverageCompleteness: 6,
    logicalStructure: 7,
    expressionClarity: 7,
    interviewPerformance: 6
  },
  overallComment: "中等偏上",
  primaryTechnicalGap: "没有覆盖锁等待和数据分布",
  primaryExpressionGap: "开头没有先给排查框架",
  engineeringMindsetGap: "缺少验证、灰度、回滚意识",
  retryInstruction: "下一版按确认范围 → 定位 SQL → 执行计划 → 优化 → 验证"
};

function createSim() {
  const questions = [
    {
      id: "mysql-q1",
      question: "线上慢 SQL 怎么排查?",
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
  const calls = [];

  function ok(body, status = 200) {
    return Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body))
    });
  }
  function bad(status, body) {
    return Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body))
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
      const list = attempts.filter((a) => a.questionId === qid).slice();
      // attach latest score per attempt
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
              feedback: latest.feedback ?? null,
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
        createdAt: new Date(Date.now() + attempts.length).toISOString(),
        status: "answered"
      };
      attempts.push(record);
      return ok(record, 201);
    }

    const scoreMatch = parsed.pathname.match(
      /^\/api\/attempts\/([A-Za-z0-9_-]+)\/score$/
    );
    if (scoreMatch && method === "POST") {
      const attemptId = scoreMatch[1];
      const body = JSON.parse(options.body ?? "{}");
      let summary = body.summary ?? null;
      if (!summary && body.rawResponse) {
        try {
          summary = JSON.parse(body.rawResponse);
        } catch {
          return bad(400, {
            error: "rawResponse is not valid JSON",
            code: "SCORING_NOT_JSON",
            path: "rawResponse"
          });
        }
      }
      // Minimal field check matching ScoreSummary's gap-field rule.
      if (!summary?.engineeringMindsetGap) {
        return bad(400, {
          error: "missing engineeringMindsetGap",
          code: "SCORE_SUMMARY_INVALID",
          path: "engineeringMindsetGap"
        });
      }
      const record = {
        attemptId,
        scoredAt: new Date().toISOString(),
        feedbackPromptVersion: "interview-coach-v2",
        summary,
        feedback: null
      };
      scores.push(record);
      return ok(record, 201);
    }

    return bad(404, { error: "not found" });
  }

  return { fetch, attempts, scores, calls };
}

test("save attempt then paste valid score JSON renders the feedback card", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  // Enter practice + save an attempt.
  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "我会先看慢查询日志,然后用 explain。";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);

  assert.equal(sim.attempts.length, 1);

  // Open the score paste form.
  document.querySelector("[data-toggle-score]").click();
  assert.equal(document.querySelector("[data-score-form]").hidden, false);

  // Paste valid JSON and submit.
  const scoreForm = document.getElementById("score-input-form");
  scoreForm.querySelector("[name=rawResponse]").value = JSON.stringify(validSummary);
  scoreForm.requestSubmit();
  await flushDom(dom, 6);

  // Server received exactly one score POST.
  assert.equal(sim.scores.length, 1);

  // Feedback card now shows scores + gaps.
  const big = document.querySelector("[data-big-score]");
  // average of 7+6+7+7+6 = 33/5 = 6.6, rendered to 1 decimal.
  assert.equal(big.textContent, "6.6");

  const techGap = document.querySelector("[data-gap-technical]");
  const exprGap = document.querySelector("[data-gap-expression]");
  const engGap = document.querySelector("[data-gap-engineering]");
  const retry = document.querySelector("[data-retry-instruction]");
  assert.match(techGap.textContent, /锁等待/);
  assert.match(exprGap.textContent, /排查框架/);
  assert.match(engGap.textContent, /回滚/);
  assert.match(retry.textContent, /验证/);

  // Empty placeholder is now hidden, ok alert shown.
  assert.equal(document.querySelector("[data-feedback-empty]").hidden, true);
  assert.equal(document.querySelector("[data-feedback-ok]").hidden, false);
});

test("pasting JSON missing engineeringMindsetGap shows server-side validation failure", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "answer";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);

  document.querySelector("[data-toggle-score]").click();
  const scoreForm = document.getElementById("score-input-form");
  const bad = { ...validSummary };
  delete bad.engineeringMindsetGap;
  scoreForm.querySelector("[name=rawResponse]").value = JSON.stringify(bad);
  scoreForm.requestSubmit();
  await flushDom(dom, 6);

  const status = document.querySelector("[data-score-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /评分失败/);
  // Feedback card stays in empty state.
  assert.equal(document.querySelector("[data-feedback-empty]").hidden, false);
});

test("pasting non-JSON shows a parse-failure status", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "answer";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);

  document.querySelector("[data-toggle-score]").click();
  const scoreForm = document.getElementById("score-input-form");
  scoreForm.querySelector("[name=rawResponse]").value = "not json";
  scoreForm.requestSubmit();
  await flushDom(dom, 6);

  const status = document.querySelector("[data-score-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
});

test("submitting score without an attempt selected shows an inline error", async () => {
  const sim = createSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  // Enter practice but never save an attempt.
  document.querySelector('[data-view-link="practice"]').click();
  document.querySelector("[data-toggle-score]").click();
  const scoreForm = document.getElementById("score-input-form");
  scoreForm.querySelector("[name=rawResponse]").value = JSON.stringify(validSummary);
  scoreForm.requestSubmit();
  await flushDom(dom, 4);

  const status = document.querySelector("[data-score-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /先保存/);
});
