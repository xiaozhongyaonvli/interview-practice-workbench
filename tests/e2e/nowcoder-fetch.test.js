// Step 8 e2e: NowCoder fetch tab + failure-to-manual fallback path.
//
// Verifies:
// - the nowcoder tab reveals a fetch form
// - successful fetch shows the direct-to-question-pool status
// - when fetch fails the user can switch to the manual tab and still
//   save an article, preserving the manual rescue path

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function submitForm(dom, form) {
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
}

function createSim({ nowCoderResponse }) {
  const articles = [];
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
    if (parsed.pathname === "/api/questions" && method === "GET") {
      return ok({
        questions: [],
        meta: { total: 0, filtered: 0, categories: [], statuses: [] }
      });
    }
    if (parsed.pathname === "/api/articles/manual" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      const record = {
        id: `manual-${articles.length}`,
        source: "manual",
        query: body.query,
        title: body.title,
        text: body.text,
        fetchedAt: new Date().toISOString()
      };
      articles.push(record);
      return ok(record, 201);
    }
    if (parsed.pathname === "/api/sources/nowcoder/fetch" && method === "POST") {
      if (nowCoderResponse.status >= 400) {
        return ok(nowCoderResponse.body, nowCoderResponse.status);
      }
      for (const a of nowCoderResponse.body.savedArticles ?? nowCoderResponse.body.saved ?? []) {
        articles.push(a);
      }
      return ok(nowCoderResponse.body);
    }
    return ok({ error: "not found" }, 404);
  }

  return { fetch, articles, calls };
}

test("clicking the 牛客 tab reveals the fetch form", async () => {
  const sim = createSim({
    nowCoderResponse: { status: 200, body: { saved: [], failed: [], discovered: 0, searchUrl: "" } }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="nowcoder"]').click();
  assert.equal(document.querySelector('[data-source-panel="nowcoder"]').hidden, false);
  assert.equal(document.querySelector("#nowcoder-fetch-form"), document.getElementById("nowcoder-fetch-form"));
});

test("successful fetch shows direct question-pool status", async () => {
  const saved = [
    {
      id: "nowcoder-mysql-1",
      source: "nowcoder",
      sourceUrl: "https://www.nowcoder.com/discuss/1",
      query: "mysql",
      title: "字节二面面经",
      text: "正文",
      fetchedAt: "2026-05-05T10:00:00Z"
    }
  ];
  const sim = createSim({
    nowCoderResponse: {
      status: 200,
      body: {
        savedArticles: saved,
        savedQuestions: [{ id: "mysql-q1" }],
        failed: [],
        discovered: 1,
        classifiedNo: 2,
        skippedUrls: [],
        searchUrl: "url"
      }
    }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="nowcoder"]').click();
  submitForm(dom, document.getElementById("nowcoder-fetch-form"));
  await flushDom(dom, 8);

  const status = document.querySelector('[data-source-panel="nowcoder"] [data-source-status]');
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /已新增 1 个问题/);
  assert.match(status.textContent, /抓 1 篇/);
  assert.match(status.textContent, /非面经 2/);
  assert.equal(document.querySelector("[data-imported-list]"), null);
});

test("feed fetch refreshes the __feed__ pool and candidate can be accepted", async () => {
  const feedQuestion = {
    id: "feed-q1",
    question: "Redis 分布式锁有什么问题？",
    category: "Redis",
    tags: ["Redis"],
    difficulty: "medium",
    source: "nowcoder",
    sourceUrl: "https://www.nowcoder.com/discuss/1",
    sourceTitle: "后端开发面经",
    evidence: "Redis 分布式锁有什么问题",
    query: "__feed__",
    confidence: 0.9,
    status: "candidate",
    createdAt: "2026-05-05T10:00:00Z",
    updatedAt: "2026-05-05T10:00:00Z"
  };
  const questions = [feedQuestion];
  const sim = createSim({
    nowCoderResponse: {
      status: 200,
      body: {
        partitionQuery: "__feed__",
        savedArticles: [
          {
            id: "nowcoder-feed-1",
            source: "nowcoder",
            sourceUrl: "https://www.nowcoder.com/discuss/1",
            query: "__feed__",
            title: "后端开发面经",
            text: "正文",
            fetchedAt: "2026-05-05T10:00:00Z"
          }
        ],
        savedQuestions: [{ id: "feed-q1" }],
        failed: [],
        discovered: 1,
        classifiedNo: 0,
        skippedUrls: [],
        searchUrl: "url"
      }
    }
  });

  const originalFetch = sim.fetch;
  sim.fetch = (url, options = {}) => {
    const method = (options.method ?? "GET").toUpperCase();
    const parsed = new URL(String(url), "http://127.0.0.1/");
    if (parsed.pathname === "/api/questions" && method === "GET") {
      const q = parsed.searchParams.get("query") ?? "";
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            questions: q === "__feed__" ? questions : [],
            meta: { total: q === "__feed__" ? questions.length : 0, filtered: 0, categories: [], statuses: [] }
          }),
        text: () => Promise.resolve("{}")
      });
    }
    if (parsed.pathname === "/api/questions/feed-q1" && method === "PATCH") {
      const body = JSON.parse(options.body ?? "{}");
      questions[0] = { ...questions[0], status: body.status };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(questions[0]),
        text: () => Promise.resolve(JSON.stringify(questions[0]))
      });
    }
    return originalFetch(url, options);
  };

  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="nowcoder"]').click();
  submitForm(dom, document.getElementById("nowcoder-fetch-form"));
  await flushDom(dom, 10);

  const card = document.querySelector('[data-question-id="feed-q1"]');
  assert.ok(card, "feed question should render after fetch");
  const acceptBtn = card.querySelector('[data-question-action="accept"]');
  assert.ok(acceptBtn, "candidate question should expose an accept action");

  acceptBtn.click();
  await flushDom(dom, 8);

  const summary = document.querySelector("[data-toolbar-summary]");
  assert.match(summary.textContent, /已保留/);
  assert.equal(questions[0].status, "accepted");
});

test("fetch failure leaves the user free to use the manual paste tab", async () => {
  const sim = createSim({
    nowCoderResponse: {
      status: 400,
      body: { error: "HTTP 500", code: "NOWCODER_FETCH_FAILED", path: "status" }
    }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  // 1. nowcoder fetch fails
  document.querySelector('[data-source-tab="nowcoder"]').click();
  submitForm(dom, document.getElementById("nowcoder-fetch-form"));
  await flushDom(dom, 8);
  const failStatus = document.querySelector(
    '[data-source-panel="nowcoder"] [data-source-status]'
  );
  assert.equal(failStatus.dataset.sourceStatusTone, "error");
  assert.match(failStatus.textContent, /抓取失败/);

  // 2. user switches to manual tab and saves an article, the rescue path
  document.querySelector('[data-source-tab="manual"]').click();
  const manualForm = document.getElementById("manual-import-form");
  manualForm.querySelector("[name=query]").value = "mysql";
  manualForm.querySelector("[name=title]").value = "手动 MySQL 面经";
  manualForm.querySelector("[name=text]").value = "面经正文...";
  submitForm(dom, manualForm);
  await flushDom(dom, 8);

  // The article store now contains the manually-pasted record.
  assert.equal(sim.articles.length, 1);
  assert.equal(sim.articles[0].source, "manual");

  const okStatus = document.querySelector(
    '[data-source-panel="manual"] [data-source-status]'
  );
  assert.equal(okStatus.dataset.sourceStatusTone, "ok");
  assert.match(okStatus.textContent, /已保存/);
});
