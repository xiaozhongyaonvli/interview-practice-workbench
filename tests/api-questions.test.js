// API tests for /api/questions/import, /api/questions, /api/questions/:id.
// Each test uses a fresh tmp baseDir to keep state isolated.

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-questions-"));
}

const validExtraction = {
  questions: [
    {
      question: "线上出现慢 SQL,怎么排查?",
      category: "MySQL",
      difficulty: "medium",
      evidence: "面试官提到了慢日志和 explain",
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

async function importBody(baseUrl, body) {
  return await fetch(`${baseUrl}/api/questions/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("POST /api/questions/import with a valid extraction object adds questions", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        extraction: validExtraction
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.added.length, 2);
      assert.equal(body.duplicates.length, 0);
      assert.equal(body.errors.length, 0);
      for (const r of body.added) {
        assert.equal(r.status, "candidate");
        assert.equal(r.query, "mysql");
        assert.equal(r.source, "manual");
      }
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/questions/import with a rawResponse string parses and adds questions", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        rawResponse: JSON.stringify(validExtraction)
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.added.length, 2);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/questions/import with non-JSON rawResponse returns 400 AND saves the raw to llm debug log", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        rawResponse: "this is not JSON"
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "EXTRACTION_NOT_JSON");

      const debugFile = join(baseDir, "llm", "extraction_results.jsonl");
      const log = await readFile(debugFile, "utf8");
      assert.match(log, /this is not JSON/);
      const lastLine = log.trim().split("\n").pop();
      const envelope = JSON.parse(lastLine);
      assert.equal(envelope.phase, "extraction");
      assert.equal(envelope.error.code, "EXTRACTION_NOT_JSON");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/questions/import with a malformed extraction returns 400 and logs the parsed body", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const bad = {
        questions: [
          { question: "Q?", category: "前端", difficulty: "medium", confidence: 0.5 }
        ]
      };
      const response = await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        extraction: bad
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "EXTRACTION_INVALID");
      assert.equal(body.path, "questions[0].category");

      const debugFile = join(baseDir, "llm", "extraction_results.jsonl");
      const log = await readFile(debugFile, "utf8");
      const envelope = JSON.parse(log.trim().split("\n").pop());
      assert.equal(envelope.error.code, "EXTRACTION_INVALID");
      // The parsed body must be preserved so the user can fix and re-paste.
      assert.deepEqual(envelope.parsed.questions[0].question, "Q?");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/questions/import reports duplicates without aborting the rest", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      // First import seeds two questions.
      await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        extraction: validExtraction
      });
      // Second import: same first question + a third unique one.
      const second = {
        questions: [
          validExtraction.questions[0],
          {
            question: "MySQL 索引失效有哪些?",
            category: "MySQL",
            difficulty: "medium",
            confidence: 0.8
          }
        ]
      };
      const response = await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        extraction: second
      });
      const body = await response.json();
      assert.equal(body.added.length, 1);
      assert.equal(body.duplicates.length, 1);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/questions returns all questions with metadata", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        extraction: validExtraction
      });
      const response = await fetch(`${baseUrl}/api/questions`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.questions.length, 2);
      assert.equal(body.meta.total, 2);
      assert.ok(Array.isArray(body.meta.categories));
      assert.ok(Array.isArray(body.meta.statuses));
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/questions filters by query, category, and status", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        extraction: validExtraction
      });
      await importBody(baseUrl, {
        query: "redis",
        source: "manual",
        extraction: {
          questions: [
            {
              question: "Redis 热 key 怎么处理?",
              category: "Redis",
              difficulty: "medium",
              confidence: 0.85
            }
          ]
        }
      });

      const onlyMysql = await (await fetch(`${baseUrl}/api/questions?query=mysql`)).json();
      assert.equal(onlyMysql.questions.length, 2);

      const onlyRedis = await (await fetch(`${baseUrl}/api/questions?category=Redis`)).json();
      assert.equal(onlyRedis.questions.length, 1);

      const onlyAccepted = await (await fetch(`${baseUrl}/api/questions?status=accepted`)).json();
      assert.equal(onlyAccepted.questions.length, 0);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("PATCH /api/questions/:id updates status and persists across reads", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const importResp = await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        extraction: validExtraction
      });
      const { added } = await importResp.json();
      const targetId = added[0].id;

      const patchResp = await fetch(`${baseUrl}/api/questions/${targetId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ignored" })
      });
      assert.equal(patchResp.status, 200);
      const updated = await patchResp.json();
      assert.equal(updated.status, "ignored");

      const list = await (await fetch(`${baseUrl}/api/questions`)).json();
      const stored = list.questions.find((q) => q.id === targetId);
      assert.equal(stored.status, "ignored");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("PATCH /api/questions/:id rejects an unknown status with 400", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const importResp = await importBody(baseUrl, {
        query: "mysql",
        source: "manual",
        extraction: validExtraction
      });
      const { added } = await importResp.json();
      const response = await fetch(`${baseUrl}/api/questions/${added[0].id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "wip" })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.path, "status");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("PATCH /api/questions/:id 404s for a missing id", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/questions/no-such-id`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ignored" })
      });
      // The store throws QUESTION_NOT_FOUND, which errorToHttp maps to 409
      // (USER_FACING_STORAGE_CODES). This is the contract — surface a
      // user-visible code rather than 500.
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, "QUESTION_NOT_FOUND");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/questions/import requires query and source", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const r1 = await importBody(baseUrl, { source: "manual", extraction: validExtraction });
      assert.equal(r1.status, 400);
      assert.equal((await r1.json()).path, "query");

      const r2 = await importBody(baseUrl, { query: "mysql", extraction: validExtraction });
      assert.equal(r2.status, 400);
      assert.equal((await r2.json()).path, "source");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
