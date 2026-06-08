import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom, flushDom } from "../helpers/buildAppDom.js";

function jsonResponse(body, status = 200, extra = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return extra.headers?.[name.toLowerCase()] ?? null;
      }
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  });
}

function createApiSim() {
  const calls = [];
  let previewBody = {
    detected: { questions: true, cards: true },
    local: { questions: 2, cards: 1 },
    incoming: { questions: 3, cards: 1 },
    requiresDecision: { questions: true, cards: true },
    validation: {
      questions: { included: true, incoming: 3, valid: 3, invalid: 0, errors: [] },
      cards: { included: true, incoming: 1, valid: 1, invalid: 0, errors: [] }
    }
  };

  function fetch(url, options = {}) {
    const method = (options.method ?? "GET").toUpperCase();
    calls.push({ method, url: String(url), body: options.body ?? null });
    const parsed = new URL(String(url), "http://127.0.0.1/");

    if (parsed.pathname === "/api/questions" && method === "GET") {
      return jsonResponse({
        questions: [],
        meta: { total: 0, filtered: 0, categories: [], statuses: [] }
      });
    }

    if (parsed.pathname === "/api/cards" && method === "GET") {
      return jsonResponse({ cards: [] });
    }

    if (parsed.pathname === "/api/export" && method === "GET") {
      return jsonResponse(
        { schema: "interview-training-workbench.backup", version: 1, sections: {} },
        200,
        {
          headers: {
            "content-disposition": 'attachment; filename="backup.json"'
          }
        }
      );
    }

    if (parsed.pathname === "/api/import/preview" && method === "POST") {
      return jsonResponse(previewBody);
    }

    if (parsed.pathname === "/api/import/apply" && method === "POST") {
      return jsonResponse({
        questions: {
          mode: "append",
          before: 2,
          incoming: 3,
          after: 4,
          added: 2,
          replaced: 1,
          duplicates: 1,
          invalid: 0
        },
        cards: {
          mode: "replace",
          before: 1,
          incoming: 1,
          after: 1,
          added: 1,
          replaced: 1,
          duplicates: 0,
          invalid: 0
        }
      });
    }

    return jsonResponse({ error: "not found" }, 404);
  }

  return {
    calls,
    fetch,
    setPreview(body) {
      previewBody = body;
    }
  };
}

function setImportFile(input, text) {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [
      {
        name: "backup.json",
        text: () => Promise.resolve(text)
      }
    ]
  });
}

test("export panel calls /api/export with the selected scope", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document, URL } = dom.window;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};

  const form = document.querySelector("[data-export-form]");
  form.querySelector("[data-export-scope]").value = "cards";
  form.requestSubmit();
  await flushDom(dom, 6);

  assert.ok(sim.calls.find((call) => call.method === "GET" && call.url === "/api/export?scope=cards"));
  const status = document.querySelector("[data-backup-status]");
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /backup\.json/);
});

test("import preview shows detected sections and required decisions", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;
  setImportFile(
    document.querySelector("[data-import-file]"),
    JSON.stringify({ schema: "interview-training-workbench.backup", version: 1, sections: {} })
  );

  document.querySelector("[data-import-preview]").click();
  await flushDom(dom, 8);

  assert.ok(sim.calls.find((call) => call.method === "POST" && call.url === "/api/import/preview"));
  assert.equal(document.querySelector("[data-import-summary]").hidden, false);
  assert.match(document.querySelector("[data-import-summary]").textContent, /题目库/);
  assert.match(document.querySelector("[data-import-summary]").textContent, /卡片库/);
  assert.equal(document.querySelectorAll(".import-decision").length, 2);
  assert.equal(document.querySelector("[data-import-apply]").disabled, false);
});

test("import apply sends selected per-section modes", async () => {
  const sim = createApiSim();
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;
  setImportFile(
    document.querySelector("[data-import-file]"),
    JSON.stringify({ schema: "interview-training-workbench.backup", version: 1, sections: {} })
  );

  document.querySelector("[data-import-preview]").click();
  await flushDom(dom, 8);
  document.querySelector('input[name="import-mode-cards"][value="replace"]').checked = true;
  document.querySelector("[data-import-apply]").click();
  await flushDom(dom, 8);

  const applyCall = sim.calls.find((call) => call.method === "POST" && call.url === "/api/import/apply");
  assert.ok(applyCall);
  const submitted = JSON.parse(applyCall.body);
  assert.equal(submitted.mode.questions, "append");
  assert.equal(submitted.mode.cards, "replace");
  const status = document.querySelector("[data-backup-status]");
  assert.equal(status.dataset.sourceStatusTone, "ok");
  assert.match(status.textContent, /导入完成/);
});

test("invalid preview disables import apply", async () => {
  const sim = createApiSim();
  sim.setPreview({
    detected: { questions: true, cards: false },
    local: { questions: 0, cards: 0 },
    incoming: { questions: 1, cards: 0 },
    requiresDecision: { questions: false, cards: false },
    validation: {
      questions: { included: true, incoming: 1, valid: 0, invalid: 1, errors: [] },
      cards: { included: false, incoming: 0, valid: 0, invalid: 0, errors: [] }
    }
  });
  const dom = await buildAppDom({ fetch: sim.fetch });
  const { document } = dom.window;
  setImportFile(
    document.querySelector("[data-import-file]"),
    JSON.stringify({ schema: "interview-training-workbench.backup", version: 1, sections: {} })
  );

  document.querySelector("[data-import-preview]").click();
  await flushDom(dom, 8);

  assert.equal(document.querySelector("[data-import-apply]").disabled, true);
  assert.match(document.querySelector("[data-backup-status]").textContent, /无效记录/);
});
