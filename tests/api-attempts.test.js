// API tests for /api/attempts.
// Each test gets a fresh tmp baseDir so attempt log state is isolated.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-attempts-"));
}

async function postAttempt(baseUrl, body) {
  return await fetch(`${baseUrl}/api/attempts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("POST /api/attempts with a valid body returns 201 and the new record", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await postAttempt(baseUrl, {
        questionId: "mysql-slow-sql",
        answer: "我会先看慢查询日志,然后用 explain 看执行计划..."
      });
      assert.equal(response.status, 201);
      const record = await response.json();
      assert.equal(record.questionId, "mysql-slow-sql");
      assert.equal(record.status, "answered");
      assert.match(record.attemptId, /^attempt-/);
      assert.match(record.createdAt, /\d{4}-\d{2}-\d{2}T/);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts with an empty answer returns 400", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await postAttempt(baseUrl, {
        questionId: "mysql-slow-sql",
        answer: "   "
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.path, "answer");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts rejects an unsafe questionId", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await postAttempt(baseUrl, {
        questionId: "mysql/../escape",
        answer: "answer"
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.path, "questionId");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts allows multiple answers for the same questionId, each with its own attemptId", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const r1 = await (await postAttempt(baseUrl, {
        questionId: "mysql-slow-sql",
        answer: "version 1"
      })).json();
      const r2 = await (await postAttempt(baseUrl, {
        questionId: "mysql-slow-sql",
        answer: "version 2"
      })).json();
      assert.notEqual(r1.attemptId, r2.attemptId);

      const list = await (
        await fetch(`${baseUrl}/api/attempts?questionId=mysql-slow-sql`)
      ).json();
      assert.equal(list.attempts.length, 2);
      // Listed oldest-first.
      assert.equal(list.attempts[0].answer, "version 1");
      assert.equal(list.attempts[1].answer, "version 2");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/attempts requires a questionId", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/attempts`);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.path, "questionId");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/attempts isolates attempts by questionId", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      await postAttempt(baseUrl, { questionId: "mysql-slow-sql", answer: "a1" });
      await postAttempt(baseUrl, { questionId: "redis-hot-key", answer: "a2" });

      const mysql = await (
        await fetch(`${baseUrl}/api/attempts?questionId=mysql-slow-sql`)
      ).json();
      const redis = await (
        await fetch(`${baseUrl}/api/attempts?questionId=redis-hot-key`)
      ).json();
      assert.equal(mysql.attempts.length, 1);
      assert.equal(redis.attempts.length, 1);
      assert.equal(mysql.attempts[0].answer, "a1");
      assert.equal(redis.attempts[0].answer, "a2");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/attempts for an unknown questionId returns an empty list, not 404", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/attempts?questionId=never-asked`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.attempts, []);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
