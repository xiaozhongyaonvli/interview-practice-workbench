// Step 2 e2e: the manual article import flow inside the source-box.
//
// We do not start the real HTTP server in these tests. Instead window.fetch
// is replaced with a tiny in-memory simulator (installed via beforeParse so
// the app's startup code sees it on first call). API correctness against the
// real server is covered by tests/api-articles.test.js.

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

/** Build a fetch stub that simulates GET /api/articles + POST /api/articles/manual. */
function createApiSim() {
  const store = [];
  const calls = [];

  function fetch(url, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    calls.push({ method, url: String(url), body: options.body ?? null });

    const parsed = new URL(String(url), "http://127.0.0.1/");

    if (parsed.pathname === "/api/articles" && method === "GET") {
      const q = parsed.searchParams.get("query");
      const articles = store.filter((a) => a.query === q);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ articles }),
        text: () => Promise.resolve(JSON.stringify({ articles }))
      });
    }

    if (parsed.pathname === "/api/articles/manual" && method === "POST") {
      const body = JSON.parse(options.body ?? "{}");
      if (!body.text || !body.text.trim()) {
        const err = { error: "text required", code: "ARTICLE_INPUT_INVALID", path: "text" };
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve(err),
          text: () => Promise.resolve(JSON.stringify(err))
        });
      }
      const record = {
        id: `manual-${body.query}-${Date.now()}-${store.length}`,
        source: "manual",
        query: body.query,
        title: body.title,
        text: body.text,
        fetchedAt: new Date().toISOString()
      };
      store.push(record);
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve(record),
        text: () => Promise.resolve(JSON.stringify(record))
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "not found" }),
      text: () => Promise.resolve("not found")
    });
  }

  return { fetch, store, calls };
}

test("the source-box shows the manual paste form by default", async () => {
  const { fetch } = createApiSim();
  const dom = await buildAppDom({ fetch });
  const { document } = dom.window;

  const manual = document.querySelector('[data-source-panel="manual"]');
  const nowcoder = document.querySelector('[data-source-panel="nowcoder"]');

  assert.ok(manual, "manual panel exists");
  assert.ok(nowcoder, "nowcoder panel exists");
  assert.equal(manual.hidden, false, "manual panel is visible by default");
  assert.equal(nowcoder.hidden, true, "nowcoder panel starts hidden");
});

test("clicking the 自动抓题 tab swaps panel visibility", async () => {
  const { fetch } = createApiSim();
  const dom = await buildAppDom({ fetch });
  const { document } = dom.window;

  document.querySelector('[data-source-tab="nowcoder"]').click();

  assert.equal(document.querySelector('[data-source-panel="manual"]').hidden, true);
  assert.equal(document.querySelector('[data-source-panel="nowcoder"]').hidden, false);
});

test("submitting a manual article saves it without rendering an imported article list", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  const form = document.getElementById("manual-import-form");
  form.querySelector("[name=query]").value = "mysql";
  form.querySelector("[name=title]").value = "粘贴的一段 MySQL 面经";
  form.querySelector("[name=text]").value = "面试官问了 InnoDB 的 ACID...";

  // form.requestSubmit() asks the browser to submit while still firing the
  // submit event — the right primitive for a form-validation flow.
  form.requestSubmit();
  await flushDom(dom);

  // Server received exactly one POST.
  const posts = sim.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/articles/manual");
  assert.equal(sim.store.length, 1);
  assert.equal(sim.store[0].title, "粘贴的一段 MySQL 面经");

  // Phase A feed refactor removed the imported-article UI; saving a manual
  // article is now only a source intake/rescue path.
  assert.equal(document.querySelector("[data-imported-list]"), null);
  assert.equal(document.querySelector("[data-article-preview]"), null);

  // Status banner reflects success.
  const status = document.querySelector("[data-source-status]");
  assert.equal(status.hidden, false);
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /已保存/);
});

test("submitting with empty text shows an inline error and does not call the API", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;

  const form = document.getElementById("manual-import-form");
  form.querySelector("[name=query]").value = "mysql";
  form.querySelector("[name=title]").value = "标题";
  form.querySelector("[name=text]").value = "   ";

  form.requestSubmit();
  await flushDom(dom);

  const posts = sim.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 0, "no POST should fire when text is blank");

  const status = document.querySelector("[data-source-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /正文/);
});

test("server-side ARTICLE_INPUT_INVALID surfaces as a save-failed status", async () => {
  // Custom handler that always rejects POST with 400 to simulate a
  // server-side validation failure even when the front-end pre-check passes.
  function fetch(url, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ articles: [] }),
        text: () => Promise.resolve("")
      });
    }
    return Promise.resolve({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: "query must contain only A-Za-z0-9_-",
          code: "ARTICLE_INPUT_INVALID",
          path: "query"
        }),
      text: () => Promise.resolve("")
    });
  }

  const dom = await buildAppDom({ fetch });
  const { document } = dom.window;

  const form = document.getElementById("manual-import-form");
  form.querySelector("[name=query]").value = "mysql";
  form.querySelector("[name=title]").value = "标题";
  form.querySelector("[name=text]").value = "正文";

  form.requestSubmit();
  await flushDom(dom);

  const status = document.querySelector("[data-source-status]");
  assert.equal(status.dataset.sourceStatusTone, "error");
  assert.match(status.textContent, /保存失败/);
});
