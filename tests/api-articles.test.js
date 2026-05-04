// API tests for /api/articles/manual and /api/articles.
// Each test gets a private tmp baseDir so storage state stays isolated.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-articles-"));
}

const validBody = {
  query: "mysql",
  title: "字节二面 MySQL 面经",
  text: "面试官问了 InnoDB 的 ACID 怎么保证..."
};

test("POST /api/articles/manual with valid body returns 201 and the record", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/articles/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody)
      });
      assert.equal(response.status, 201);
      const record = await response.json();
      assert.equal(record.source, "manual");
      assert.equal(record.query, "mysql");
      assert.equal(record.title, "字节二面 MySQL 面经");
      assert.equal(record.text, validBody.text);
      assert.match(record.id, /^manual-mysql-/);
      assert.match(record.fetchedAt, /\d{4}-\d{2}-\d{2}T/);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/articles/manual with empty text returns 400", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/articles/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validBody, text: "  " })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "ARTICLE_INPUT_INVALID");
      assert.equal(body.path, "text");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/articles/manual with empty title returns 400", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/articles/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validBody, title: "" })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.path, "title");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/articles/manual rejects unsafe query strings", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/articles/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validBody, query: "../etc/passwd" })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.path, "query");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/articles/manual rejects malformed JSON body", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/articles/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json"
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "BODY_NOT_JSON");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/articles?query=mysql returns saved articles for that query", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      // Seed two articles for mysql, one for redis.
      await fetch(`${baseUrl}/api/articles/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody)
      });
      await fetch(`${baseUrl}/api/articles/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validBody, title: "另一篇 MySQL" })
      });
      await fetch(`${baseUrl}/api/articles/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "redis",
          title: "Redis 面经",
          text: "热 key 怎么处理..."
        })
      });

      const mysqlResp = await fetch(`${baseUrl}/api/articles?query=mysql`);
      assert.equal(mysqlResp.status, 200);
      const mysql = await mysqlResp.json();
      assert.equal(Array.isArray(mysql.articles), true);
      assert.equal(mysql.articles.length, 2);
      for (const a of mysql.articles) {
        assert.equal(a.query, "mysql");
        assert.equal(a.source, "manual");
      }

      const redisResp = await fetch(`${baseUrl}/api/articles?query=redis`);
      const redis = await redisResp.json();
      assert.equal(redis.articles.length, 1);
      assert.equal(redis.articles[0].query, "redis");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/articles without a query returns 400", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/articles`);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.path, "query");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/articles?query=foo returns empty list when nothing saved", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/articles?query=mysql`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.articles, []);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("unknown /api route returns 404 with code", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/nope`);
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.equal(body.code, "API_NOT_FOUND");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
