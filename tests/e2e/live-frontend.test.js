// Tests that previously-static UI elements now drive real behavior.
//
// Each test stubs window.fetch with a small in-memory simulator and asserts
// the DOM/network response to clicks on:
//   - sidebar category buttons
//   - toolbar search box and clear-filter button
//   - the metric strip (counts come from /api/questions + /api/attempts)
//   - feedback tabs (section visibility switches when a tab is clicked)
//   - the "保存为正式卡片" button at the top of the practice view
//   - the 卡片库 view (top-nav 卡片库 link renders /api/cards data)
//   - the header "导入文章" / "+ 新建训练卡片" buttons (focus the right panel)

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

const validSummary = {
  scores: {
    technicalCorrectness: 8,
    coverageCompleteness: 7,
    logicalStructure: 8,
    expressionClarity: 7,
    interviewPerformance: 7
  },
  overallComment: "良好",
  primaryTechnicalGap: "tech-gap",
  primaryExpressionGap: "expr-gap",
  engineeringMindsetGap: "eng-gap",
  retryInstruction: "retry-instruction"
};

function buildSim({
  questions = [],
  attempts = [],
  scores = [],
  cards = []
} = {}) {
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
      return ok({ articles: [] });
    }
    if (parsed.pathname === "/api/questions" && method === "GET") {
      const q = parsed.searchParams.get("query");
      const list = q ? questions.filter((x) => x.query === q) : questions.slice();
      return ok({
        questions: list,
        meta: { total: questions.length, filtered: list.length, categories: [], statuses: [] }
      });
    }
    if (parsed.pathname === "/api/attempts" && method === "GET") {
      const qid = parsed.searchParams.get("questionId");
      const list = attempts
        .filter((a) => a.questionId === qid)
        .slice()
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
      const merged = list.map((a) => {
        const latest = scores.filter((s) => s.attemptId === a.attemptId).pop();
        return latest
          ? { ...a, status: "scored", summary: latest.summary, feedback: null, scoredAt: latest.scoredAt }
          : a;
      });
      return ok({ attempts: merged });
    }
    if (parsed.pathname === "/api/cards" && method === "GET") {
      return ok({ cards });
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
      const summary = body.summary ?? JSON.parse(body.rawResponse);
      const r = {
        attemptId: scoreMatch[1],
        scoredAt: new Date().toISOString(),
        feedbackPromptVersion: "interview-coach-v2",
        summary,
        feedback: null
      };
      scores.push(r);
      return ok(r, 201);
    }
    if (parsed.pathname === "/api/cards/from-attempt" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const attempt = attempts.find((a) => a.attemptId === body.attemptId);
      const question = questions.find((q) => q.id === attempt?.questionId);
      const score = scores.filter((s) => s.attemptId === body.attemptId).pop();
      if (cards.find((c) => c.id === question.id) && !body.overwrite) {
        return ok({ error: "duplicate", code: "CARD_DUPLICATE_ID" }, 400);
      }
      const card = {
        id: question.id,
        title: question.question,
        count: 0,
        category: body.category,
        tags: [body.category],
        difficulty: body.difficulty,
        createdAt: "2026-05-04",
        updatedAt: "2026-05-05",
        question: question.question,
        myAnswer: attempt.answer,
        feedbackPromptVersion: "interview-coach-v2",
        feedback: {
          performanceScore: { scores: score.summary.scores, overallComment: score.summary.overallComment }
        }
      };
      const idx = cards.findIndex((c) => c.id === card.id);
      if (idx >= 0) cards[idx] = card;
      else cards.push(card);
      return ok(card, 201);
    }
    return ok({ error: "not found" }, 404);
  }
  return { fetch, questions, attempts, scores, cards, calls };
}

const baseQuestions = [
  {
    id: "mysql-q1",
    question: "MySQL 慢 SQL 怎么排查?",
    category: "MySQL",
    tags: ["MySQL", "性能"],
    difficulty: "medium",
    source: "manual",
    sourceUrl: null,
    sourceTitle: null,
    evidence: "面试官问了慢日志",
    query: "mysql",
    confidence: 0.86,
    status: "candidate",
    createdAt: "2026-05-04",
    updatedAt: "2026-05-04"
  },
  {
    id: "redis-q1",
    question: "Redis 热 key 怎么处理?",
    category: "Redis",
    tags: ["Redis"],
    difficulty: "medium",
    source: "manual",
    sourceUrl: null,
    sourceTitle: null,
    evidence: "热 key",
    query: "mysql", // intentional: cross-category but same query, to test sidebar filter
    confidence: 0.9,
    status: "candidate",
    createdAt: "2026-05-04",
    updatedAt: "2026-05-04"
  },
  {
    id: "mysql-q2",
    question: "InnoDB 的 ACID 怎么保证?",
    category: "MySQL",
    tags: ["MySQL", "事务"],
    difficulty: "hard",
    source: "manual",
    sourceUrl: null,
    sourceTitle: null,
    evidence: "ACID",
    query: "mysql",
    confidence: 0.92,
    status: "ignored",
    createdAt: "2026-05-04",
    updatedAt: "2026-05-04"
  }
];

test("sidebar category counts reflect the live question pool", async () => {
  const sim = buildSim({ questions: baseQuestions });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  const counts = {
    "": document.querySelector('[data-category-count=""]').textContent,
    MySQL: document.querySelector('[data-category-count="MySQL"]').textContent,
    Redis: document.querySelector('[data-category-count="Redis"]').textContent
  };
  assert.equal(counts[""], "3", "全部 should equal total");
  assert.equal(counts.MySQL, "2");
  assert.equal(counts.Redis, "1");
});

test("clicking a sidebar category filters the question grid", async () => {
  const sim = buildSim({ questions: baseQuestions });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  document.querySelector('[data-category="Redis"]').click();
  const cards = document.querySelectorAll("[data-question-grid] [data-question-id]");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].dataset.questionId, "redis-q1");

  // clear filter button restores all
  document.querySelector("[data-clear-filter]").click();
  const allCards = document.querySelectorAll("[data-question-grid] [data-question-id]");
  assert.equal(allCards.length, 3);
});

test("the toolbar search input filters cards by question text + tags", async () => {
  const sim = buildSim({ questions: baseQuestions });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  const input = document.querySelector("[data-search-input]");
  input.value = "ACID";
  input.dispatchEvent(new dom.window.Event("input"));
  // Search has a 120ms debounce; advance.
  await flushDom(dom, 5);
  await new Promise((r) => dom.window.setTimeout(r, 150));
  await flushDom(dom, 3);

  const cards = document.querySelectorAll("[data-question-grid] [data-question-id]");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].dataset.questionId, "mysql-q2");
});

test("metric strip shows total questions and updates avg-score after a scored attempt", async () => {
  const sim = buildSim({ questions: baseQuestions });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 8);
  const { document } = dom.window;

  assert.equal(document.querySelector('[data-metric="total"]').textContent, "3");
  // Score one question and expect avgScore to update on next refresh.
  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "answer";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-toggle-score]").click();
  document.getElementById("score-input-form")
    .querySelector("[name=rawResponse]").value = JSON.stringify(validSummary);
  document.getElementById("score-input-form").requestSubmit();
  await flushDom(dom, 8);

  // Go back home so refreshQuestionPool runs the metric calc again.
  document.querySelector("[data-back-home]").click();
  await flushDom(dom, 8);

  const avg = document.querySelector('[data-metric="avgScore"]').textContent;
  // 8+7+8+7+7 = 37 / 5 = 7.4
  assert.equal(avg, "7.4");
  assert.equal(document.querySelector('[data-metric="answered"]').textContent, "1");
});

test("feedback tabs switch which feedback-section is visible", async () => {
  const sim = buildSim({ questions: baseQuestions });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  // Save+score one attempt so the feedback card is populated.
  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "answer";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-toggle-score]").click();
  document.getElementById("score-input-form")
    .querySelector("[name=rawResponse]").value = JSON.stringify(validSummary);
  document.getElementById("score-input-form").requestSubmit();
  await flushDom(dom, 8);

  // Default tab is "summary" — big-score visible, expression detail hidden.
  const expressionDetail = document.querySelector('[data-feedback-section="expression"]');
  const summarySection = document.querySelector('[data-feedback-section="summary"]');
  assert.equal(expressionDetail.hidden, true);
  assert.equal(summarySection.hidden, false);

  // Click 表达 tab.
  document.querySelector('[data-feedback-tab="expression"]').click();
  assert.equal(expressionDetail.hidden, false);
  assert.equal(summarySection.hidden, true);
  assert.match(
    document.querySelector("[data-gap-expression-detail]").textContent,
    /expr-gap/
  );

  // Click 重答建议 tab.
  document.querySelector('[data-feedback-tab="retry"]').click();
  const retrySection = document.querySelector('[data-feedback-section="retry"]');
  assert.equal(retrySection.hidden, false);
  assert.match(
    document.querySelector("[data-retry-detail]").textContent,
    /retry/
  );
});

test('top "保存为正式卡片" button submits the same payload as the sidebar form', async () => {
  const sim = buildSim({ questions: baseQuestions });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  document.querySelector("[data-question-grid] [data-open-practice]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-answer-input]").value = "answer";
  document.querySelector("[data-save-attempt]").click();
  await flushDom(dom, 6);
  document.querySelector("[data-toggle-score]").click();
  document.getElementById("score-input-form")
    .querySelector("[name=rawResponse]").value = JSON.stringify(validSummary);
  document.getElementById("score-input-form").requestSubmit();
  await flushDom(dom, 8);

  // Top button should now be enabled.
  const topBtn = document.querySelector("[data-save-card-top]");
  assert.equal(topBtn.disabled, false);
  topBtn.click();
  await flushDom(dom, 6);

  const posts = sim.calls.filter((c) => c.method === "POST" && c.url === "/api/cards/from-attempt");
  assert.equal(posts.length, 1);
  assert.equal(sim.cards.length, 1);
  assert.equal(sim.cards[0].id, "mysql-q1");
});

test("clicking the 卡片库 link renders saved cards from /api/cards", async () => {
  const cards = [
    {
      id: "mysql-saved-1",
      title: "已保存的 MySQL 卡片",
      count: 0,
      category: "MySQL",
      tags: ["MySQL"],
      difficulty: "medium",
      createdAt: "2026-05-04",
      updatedAt: "2026-05-05",
      question: "Q?",
      myAnswer: "A",
      feedbackPromptVersion: "interview-coach-v2",
      feedback: {
        performanceScore: {
          scores: validSummary.scores,
          overallComment: "已沉淀的卡片"
        }
      }
    }
  ];
  const sim = buildSim({ questions: baseQuestions, cards });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  document.querySelector('[data-view-link="cards"]').click();
  await flushDom(dom, 6);

  assert.equal(document.querySelector('[data-view="cards"]').hidden, false);
  const renderedCards = document.querySelectorAll("[data-cards-grid] [data-card-id]");
  assert.equal(renderedCards.length, 1);
  assert.match(renderedCards[0].textContent, /已保存的 MySQL 卡片/);
  // Computed total = 7.4 (same summary)
  assert.match(renderedCards[0].textContent, /7\.4 \/ 10/);
});

test('header "导入文章" button switches to the manual paste panel', async () => {
  const sim = buildSim({ questions: baseQuestions });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 4);
  const { document } = dom.window;

  // First switch to the extract panel so we can verify the button toggles back.
  document.querySelector('[data-source-tab="extract"]').click();
  assert.equal(document.querySelector('[data-source-panel="manual"]').hidden, true);

  document.querySelector("[data-header-import]").click();
  assert.equal(document.querySelector('[data-source-panel="manual"]').hidden, false);
});

test('header "+ 新建训练卡片" button switches to the extract panel', async () => {
  const sim = buildSim({ questions: baseQuestions });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 4);
  const { document } = dom.window;

  document.querySelector("[data-header-new-card]").click();
  assert.equal(document.querySelector('[data-source-panel="extract"]').hidden, false);
});

test("toolbar 搜索框 + 清除筛选 协同工作", async () => {
  const sim = buildSim({ questions: baseQuestions });
  const dom = await buildAppDom({ fetch: sim.fetch });
  await flushDom(dom, 6);
  const { document } = dom.window;

  document.querySelector('[data-category="MySQL"]').click();
  // Toolbar summary should show "当前筛选 N"
  assert.match(
    document.querySelector("[data-toolbar-summary]").textContent,
    /当前筛选/
  );

  document.querySelector("[data-clear-filter]").click();
  assert.doesNotMatch(
    document.querySelector("[data-toolbar-summary]").textContent,
    /当前筛选/
  );
});
