// Step 9 e2e: real LLM hooks (extract + score) — failure paths must NOT
// block the manual-paste rescue lanes.

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function buildSim({ extractResp, llmScoreResp }) {
  const articles = [];
  const questions = [];
  const attempts = [];
  const scores = [];
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
    if (parsed.pathname === "/api/articles/manual" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const r = {
        id: `manual-${articles.length}`,
        source: "manual",
        query: body.query,
        title: body.title,
        text: body.text,
        fetchedAt: new Date().toISOString()
      };
      articles.push(r);
      return ok(r, 201);
    }
    if (parsed.pathname === "/api/questions" && method === "GET") {
      const q = parsed.searchParams.get("query");
      const list = q ? questions.filter((x) => x.query === q) : questions.slice();
      return ok({
        questions: list,
        meta: { total: questions.length, filtered: list.length, categories: [], statuses: [] }
      });
    }
    if (parsed.pathname === "/api/questions/extract" && method === "POST") {
      if (extractResp.status >= 400) return ok(extractResp.body, extractResp.status);
      for (const q of extractResp.body.added) questions.push(q);
      return ok(extractResp.body);
    }
    if (parsed.pathname === "/api/questions/import" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const parsed2 = JSON.parse(body.rawResponse);
      const added = parsed2.questions.map((q, i) => ({
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
  return { fetch, articles, questions, attempts, scores, calls };
}

const validSummary = {
  scores: {
    technicalCorrectness: 7,
    coverageCompleteness: 6,
    logicalStructure: 7,
    expressionClarity: 7,
    interviewPerformance: 6
  },
  overallComment: "中等偏上",
  primaryTechnicalGap: "缺锁等待",
  primaryExpressionGap: "结构散",
  engineeringMindsetGap: "缺验证回滚",
  retryInstruction: "下一版按发现-定位-分析-验证"
};

async function seedArticleAndQuestion(dom, document, sim) {
  // Save an article first via manual paste so /api/questions/extract has
  // input. The simulator's extract POST returns extractResp directly,
  // populating the question pool.
  document.querySelector('[data-source-tab="manual"]').click();
  const manual = document.getElementById("manual-import-form");
  manual.querySelector("[name=query]").value = "mysql";
  manual.querySelector("[name=title]").value = "面经";
  manual.querySelector("[name=text]").value = "面经正文";
  manual.requestSubmit();
  await flushDom(dom, 6);
}

test('"调用 LLM 抽题" successfully populates the question pool', async () => {
  const sim = buildSim({
    extractResp: {
      status: 200,
      body: {
        added: [
          {
            id: "llm-q1",
            question: "线上慢 SQL 怎么排查?",
            category: "MySQL",
            tags: ["MySQL"],
            difficulty: "medium",
            source: "manual",
            sourceUrl: null,
            sourceTitle: "面经",
            evidence: "evidence",
            query: "mysql",
            confidence: 0.86,
            status: "candidate",
            createdAt: "2026-05-04",
            updatedAt: "2026-05-04"
          }
        ],
        duplicates: [],
        errors: []
      }
    },
    llmScoreResp: { status: 200, body: { summary: validSummary } }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  await seedArticleAndQuestion(dom, document, sim);

  document.querySelector('[data-source-tab="extract"]').click();
  document.querySelector("[data-llm-extract]").click();
  await flushDom(dom, 8);

  const status = document.querySelector(
    '[data-source-panel="extract"] [data-source-status]'
  );
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /LLM 已抽 1 条/);

  // Question pool now shows the LLM-added question.
  const cards = document.querySelectorAll("[data-question-grid] [data-question-id]");
  assert.equal(cards.length, 1);
});

test('"调用 LLM 抽题" failure leaves the user free to paste JSON instead', async () => {
  const sim = buildSim({
    extractResp: {
      status: 400,
      body: { error: "LLM_NOT_CONFIGURED", code: "LLM_NOT_CONFIGURED", path: "service" }
    },
    llmScoreResp: { status: 200, body: { summary: validSummary } }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  await seedArticleAndQuestion(dom, document, sim);

  document.querySelector('[data-source-tab="extract"]').click();
  document.querySelector("[data-llm-extract]").click();
  await flushDom(dom, 8);

  const status = document.querySelector(
    '[data-source-panel="extract"] [data-source-status]'
  );
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /可改用粘贴 JSON/);

  // User pastes JSON manually — the rescue path
  const form = document.getElementById("extract-import-form");
  form.querySelector("[name=rawResponse]").value = JSON.stringify({
    questions: [
      {
        question: "InnoDB ACID?",
        category: "MySQL",
        difficulty: "hard",
        confidence: 0.9
      }
    ]
  });
  form.requestSubmit();
  await flushDom(dom, 8);
  assert.equal(sim.questions.length, 1);
});

test('"LLM 评分" success renders feedback card', async () => {
  const sim = buildSim({
    extractResp: {
      status: 200,
      body: {
        added: [
          {
            id: "q-1",
            question: "Q?",
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
        ],
        duplicates: [],
        errors: []
      }
    },
    llmScoreResp: { status: 201, body: { summary: validSummary, attemptId: "x" } }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  await seedArticleAndQuestion(dom, document, sim);
  document.querySelector('[data-source-tab="extract"]').click();
  document.querySelector("[data-llm-extract]").click();
  await flushDom(dom, 8);

  // Open practice + save attempt + click LLM 评分.
  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "我的回答";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-llm-score]").click();
  await flushDom(dom, 8);

  const big = document.querySelector("[data-big-score]");
  assert.equal(big.textContent, "6.6");
  const status = document.querySelector("[data-attempt-status]");
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /LLM 评分通过校验/);
});

test('"LLM 评分" failure leaves attempt intact and the user can still paste JSON', async () => {
  const sim = buildSim({
    extractResp: {
      status: 200,
      body: {
        added: [
          {
            id: "q-1",
            question: "Q?",
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
        ],
        duplicates: [],
        errors: []
      }
    },
    llmScoreResp: {
      status: 400,
      body: { error: "model timed out", code: "LLM_CALL_FAILED", path: "chatComplete" }
    }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  await seedArticleAndQuestion(dom, document, sim);
  document.querySelector('[data-source-tab="extract"]').click();
  document.querySelector("[data-llm-extract]").click();
  await flushDom(dom, 8);

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "我的回答";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);

  document.querySelector("[data-llm-score]").click();
  await flushDom(dom, 8);

  const status = document.querySelector("[data-attempt-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /可改用粘贴 JSON/);

  // Attempt still in the store; just no score — user retains data.
  assert.equal(sim.attempts.length, 1);
  assert.equal(sim.scores.length, 0);
});
