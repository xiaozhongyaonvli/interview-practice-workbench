// Step 3 e2e: extraction-import flow + question pool rendering + ignore PATCH.
//
// As in Step 2, we drive the front-end with a stubbed fetch that simulates
// the API. The real /api/questions HTTP layer is exercised by
// tests/api-questions.test.js.

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function createApiSim() {
  const articles = [];
  const questions = [];
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
            meta: {
              total: questions.length,
              filtered: list.length,
              categories: ["MySQL", "Redis"],
              statuses: ["candidate", "accepted", "ignored", "duplicate", "mastered"]
            }
          }),
        text: () => Promise.resolve("")
      });
    }

    if (parsed.pathname === "/api/questions/import" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      let parsedBody;
      try {
        parsedBody = JSON.parse(body.rawResponse ?? "");
      } catch {
        const err = { error: "rawResponse is not valid JSON", code: "EXTRACTION_NOT_JSON", path: "rawResponse" };
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve(err),
          text: () => Promise.resolve("")
        });
      }
      const added = [];
      for (let i = 0; i < parsedBody.questions.length; i += 1) {
        const item = parsedBody.questions[i];
        const id = `${body.query}-${i}-${Date.now()}`;
        const record = {
          id,
          question: item.question,
          category: item.category,
          tags: [item.category],
          difficulty: item.difficulty,
          source: body.source,
          sourceUrl: null,
          sourceTitle: null,
          evidence: item.evidence ?? null,
          query: body.query,
          confidence: item.confidence,
          status: "candidate",
          createdAt: "2026-05-04",
          updatedAt: "2026-05-04"
        };
        questions.push(record);
        added.push(record);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ added, duplicates: [], errors: [] }),
        text: () => Promise.resolve("")
      });
    }

    const patchMatch = parsed.pathname.match(/^\/api\/questions\/([A-Za-z0-9_-]+)$/);
    if (patchMatch && method === "PATCH") {
      const id = patchMatch[1];
      const body = JSON.parse(options.body ?? "{}");
      const target = questions.find((q) => q.id === id);
      if (!target) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: "not found", code: "QUESTION_NOT_FOUND" }),
          text: () => Promise.resolve("")
        });
      }
      Object.assign(target, body);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(target),
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

  return { fetch, articles, questions, calls };
}

const validExtraction = {
  questions: [
    {
      question: "线上慢 SQL 怎么排查?",
      category: "MySQL",
      difficulty: "medium",
      evidence: "面试官提到了慢日志",
      confidence: 0.86
    },
    {
      question: "InnoDB 的 ACID 怎么保证?",
      category: "MySQL",
      difficulty: "hard",
      confidence: 0.9
    }
  ]
};

test("clicking the 导入抽题 tab reveals the extraction form", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="extract"]').click();

  const extractPanel = document.querySelector('[data-source-panel="extract"]');
  const manualPanel = document.querySelector('[data-source-panel="manual"]');
  assert.equal(extractPanel.hidden, false);
  assert.equal(manualPanel.hidden, true);
});

test("submitting valid LLM extraction JSON populates the question pool", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="extract"]').click();

  const form = document.getElementById("extract-import-form");
  form.querySelector("[name=query]").value = "mysql";
  form.querySelector("[name=rawResponse]").value = JSON.stringify(validExtraction);

  form.requestSubmit();
  await flushDom(dom, 8);

  // Server received exactly one import POST.
  const posts = sim.calls.filter((c) => c.method === "POST" && c.url === "/api/questions/import");
  assert.equal(posts.length, 1);

  // Two questions were saved.
  assert.equal(sim.questions.length, 2);

  // The grid renders one card per question + a trailing add-card.
  const cards = document.querySelectorAll("[data-question-grid] [data-question-id]");
  assert.equal(cards.length, 2);

  // Status banner reflects success summary.
  const status = document.querySelector('[data-source-panel="extract"] [data-source-status]');
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /已导入 2/);
});

test("submitting non-JSON rawResponse shows a server-side failure status", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="extract"]').click();
  const form = document.getElementById("extract-import-form");
  form.querySelector("[name=query]").value = "mysql";
  form.querySelector("[name=rawResponse]").value = "not json at all";

  form.requestSubmit();
  await flushDom(dom, 8);

  const status = document.querySelector('[data-source-panel="extract"] [data-source-status]');
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /导入失败/);
});

test("clicking 忽略 on a question card sends a PATCH and visually mutes it", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  // Seed the question pool via the extraction flow.
  document.querySelector('[data-source-tab="extract"]').click();
  const form = document.getElementById("extract-import-form");
  form.querySelector("[name=query]").value = "mysql";
  form.querySelector("[name=rawResponse]").value = JSON.stringify(validExtraction);
  form.requestSubmit();
  await flushDom(dom, 8);

  // Click the 忽略 button on the first card.
  const ignoreBtn = document.querySelector('[data-question-action="ignore"]');
  assert.ok(ignoreBtn, "first card exposes an ignore button");
  ignoreBtn.click();
  await flushDom(dom, 8);

  // PATCH was sent.
  const patches = sim.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.equal(JSON.parse(patches[0].body).status, "ignored");

  // Server state changed.
  const ignored = sim.questions.filter((q) => q.status === "ignored");
  assert.equal(ignored.length, 1);

  // Re-render put the card in the muted visual state.
  const refreshedCards = document.querySelectorAll("[data-question-grid] [data-question-id]");
  // The grid still shows the ignored card so the user sees what they did.
  // It just renders with the .muted class.
  const muted = Array.from(refreshedCards).filter((el) =>
    el.closest(".training-card")?.classList.contains("muted")
  );
  assert.ok(muted.length >= 1, "at least one card is now muted");
});

test("empty question pool renders the placeholder add-card", async () => {
  const sim = createApiSim();
  // Boot without seeding any questions — sim.questions starts empty.
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  const grid = document.querySelector("[data-question-grid]");
  assert.ok(grid);
  // Placeholder add-card exists; no data-question-id cards.
  assert.equal(grid.querySelectorAll("[data-question-id]").length, 0);
  assert.ok(grid.querySelector(".add-card"));
});
