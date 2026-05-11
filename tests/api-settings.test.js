import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-settings-"));
}

test("GET /api/settings/llm returns an empty masked config by default", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/settings/llm`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body.llm, {
        apiKeyPresent: false,
        apiKeyMasked: "",
        baseURL: "",
        model: "",
        apiStyle: "",
        reasoningEffort: ""
      });
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/settings/llm persists config and never echoes the raw API key", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/settings/llm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: "sk-test-secret-1234",
          baseURL: " https://api.example.com/v1 ",
          model: " demo-model ",
          apiStyle: "chat_completions",
          reasoningEffort: " high "
        })
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.llm.apiKeyPresent, true);
      assert.notEqual(body.llm.apiKeyMasked, "sk-test-secret-1234");
      assert.equal(body.llm.baseURL, "https://api.example.com/v1");
      assert.equal(body.llm.model, "demo-model");
      assert.equal(body.llm.apiStyle, "chat_completions");
      assert.equal(body.llm.reasoningEffort, "high");

      const saved = JSON.parse(await readFile(join(baseDir, "settings.json"), "utf8"));
      assert.equal(saved.llm.apiKey, "sk-test-secret-1234");
      assert.equal(saved.llm.baseURL, "https://api.example.com/v1");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/settings/llm rejects unsupported apiStyle", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/settings/llm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiStyle: "not-real" })
      });
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.equal(body.code, "SETTINGS_INPUT_INVALID");
      assert.equal(body.path, "apiStyle");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/settings/llm/models uses the saved OpenAI-compatible model endpoint", async () => {
  const baseDir = await makeBase();
  const originalFetch = globalThis.fetch;
  try {
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/api/settings/llm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: "sk-test-secret",
          baseURL: "https://models.example.com/v1"
        })
      });

      const modelRequests = [];
      globalThis.fetch = async (url, options = {}) => {
        const href = String(url);
        if (href === "https://models.example.com/v1/models") {
          modelRequests.push({ url: href, options });
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "z-model" }, { id: "a-model" }] }),
            text: async () => ""
          };
        }
        return originalFetch(url, options);
      };

      const response = await fetch(`${baseUrl}/api/settings/llm/models`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body.models, ["a-model", "z-model"]);
      assert.equal(modelRequests.length, 1);
      assert.equal(modelRequests[0].options.headers.Authorization, "Bearer sk-test-secret");
    }, { baseDir });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/prompts/scoring renders the scoring prompt as plain text", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const params = new URLSearchParams({
        question: "How do you guarantee idempotency?",
        answer: "Use a request id and transactional checks."
      });
      const response = await fetch(`${baseUrl}/api/prompts/scoring?${params}`);
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/plain/);
      assert.match(body, /How do you guarantee idempotency\?/);
      assert.match(body, /Use a request id and transactional checks\./);
      assert.match(body, /engineeringMindsetGap/);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
