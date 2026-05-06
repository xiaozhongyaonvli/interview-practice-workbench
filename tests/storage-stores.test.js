// Round-trip tests for the four record stores (article / question / attempt
// / card). Each test isolates state in a fresh temp directory.

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createArticleStore } from "../src/storage/articleStore.js";
import { createQuestionStore } from "../src/storage/questionStore.js";
import { createAttemptStore } from "../src/storage/attemptStore.js";
import { createCardStore } from "../src/storage/cardStore.js";
import { createCrawlCursorStore } from "../src/storage/crawlCursorStore.js";
import { StorageError, ValidationError } from "../src/domain/errors.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-stores-"));
}

const articleSample = Object.freeze({
  id: "manual-mysql-001",
  source: "manual",
  query: "mysql",
  title: "我的面经粘贴",
  text: "面试官问了 ACID...",
  fetchedAt: "2026-05-04T10:00:00Z"
});

test("articleStore: append then list returns the same record", async () => {
  const baseDir = await makeBase();
  try {
    const store = createArticleStore({ baseDir });
    await store.append({ ...articleSample });
    const list = await store.listByQuery("mysql");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "manual-mysql-001");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("articleStore: separates records by query", async () => {
  const baseDir = await makeBase();
  try {
    const store = createArticleStore({ baseDir });
    await store.append({ ...articleSample });
    await store.append({ ...articleSample, id: "manual-redis-001", query: "redis" });

    const mysql = await store.listByQuery("mysql");
    const redis = await store.listByQuery("redis");
    assert.equal(mysql.length, 1);
    assert.equal(redis.length, 1);
    assert.equal(mysql[0].id, "manual-mysql-001");
    assert.equal(redis[0].id, "manual-redis-001");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("articleStore: refuses an invalid record before touching disk", async () => {
  const baseDir = await makeBase();
  try {
    const store = createArticleStore({ baseDir });
    await assert.rejects(
      store.append({ ...articleSample, source: "csdn" }),
      ValidationError
    );
    // Nothing should have been persisted.
    const list = await store.listByQuery("mysql");
    assert.deepEqual(list, []);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("articleStore.pruneOlderThan: drops nowcoder rows older than the TTL", async () => {
  const baseDir = await makeBase();
  try {
    const store = createArticleStore({ baseDir });
    const now = Date.now();
    const oldIso = new Date(now - 20 * 86400000).toISOString();
    const freshIso = new Date(now - 2 * 86400000).toISOString();
    await store.append({
      id: "nc-old", source: "nowcoder", sourceUrl: "https://www.nowcoder.com/discuss/1",
      query: "mysql", title: "old", text: "old", fetchedAt: oldIso
    });
    await store.append({
      id: "nc-fresh", source: "nowcoder", sourceUrl: "https://www.nowcoder.com/discuss/2",
      query: "mysql", title: "fresh", text: "fresh", fetchedAt: freshIso
    });

    const result = await store.pruneOlderThan({ days: 14, source: "nowcoder" });
    assert.equal(result.removedCount, 1);
    assert.equal(result.keptCount, 1);

    const list = await store.listByQuery("mysql");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "nc-fresh");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("articleStore.pruneOlderThan: leaves manual records untouched even when ancient", async () => {
  const baseDir = await makeBase();
  try {
    const store = createArticleStore({ baseDir });
    const ancientIso = new Date(Date.now() - 365 * 86400000).toISOString();
    await store.append({
      id: "manual-old", source: "manual",
      query: "mysql", title: "粘贴的", text: "粘贴的内容",
      fetchedAt: ancientIso
    });

    const result = await store.pruneOlderThan({ days: 14, source: "nowcoder" });
    assert.equal(result.removedCount, 0);
    assert.equal(result.keptCount, 1);

    const list = await store.listByQuery("mysql");
    assert.equal(list.length, 1);
    assert.equal(list[0].source, "manual");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("articleStore.pruneOlderThan: returns zero counts when articles dir is missing", async () => {
  const baseDir = await makeBase();
  try {
    const store = createArticleStore({ baseDir });
    const result = await store.pruneOlderThan({ days: 14, source: "nowcoder" });
    assert.deepEqual(result, { removedCount: 0, keptCount: 0 });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("articleStore.pruneOlderThan: rejects bad arguments", async () => {
  const baseDir = await makeBase();
  try {
    const store = createArticleStore({ baseDir });
    await assert.rejects(store.pruneOlderThan({ days: 0, source: "nowcoder" }), StorageError);
    await assert.rejects(store.pruneOlderThan({ days: 14 }), StorageError);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("articleStore.pruneOlderThan: keeps __feed__ records like any other query", async () => {
  const baseDir = await makeBase();
  try {
    const store = createArticleStore({ baseDir });
    const freshIso = new Date(Date.now() - 1 * 86400000).toISOString();
    await store.append({
      id: "nc-feed-1", source: "nowcoder", sourceUrl: "https://www.nowcoder.com/discuss/9",
      query: "__feed__", title: "feed item", text: "feed body", fetchedAt: freshIso
    });

    const result = await store.pruneOlderThan({ days: 14, source: "nowcoder" });
    assert.equal(result.removedCount, 0);
    assert.equal(result.keptCount, 1);

    const list = await store.listByQuery("__feed__");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "nc-feed-1");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

const questionSample = Object.freeze({
  id: "mysql-slow-sql",
  question: "慢 SQL 怎么排查?",
  category: "MySQL",
  tags: ["MySQL"],
  difficulty: "medium",
  source: "manual",
  evidence: "面试官提到了慢日志",
  query: "mysql",
  confidence: 0.9,
  status: "candidate",
  createdAt: "2026-05-04",
  updatedAt: "2026-05-04"
});

test("questionStore: add then list returns the question", async () => {
  const baseDir = await makeBase();
  try {
    const store = createQuestionStore({ baseDir });
    await store.add({ ...questionSample });
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "mysql-slow-sql");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("questionStore: empty pool returns an empty array", async () => {
  const baseDir = await makeBase();
  try {
    const store = createQuestionStore({ baseDir });
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("questionStore: rejects duplicate ids", async () => {
  const baseDir = await makeBase();
  try {
    const store = createQuestionStore({ baseDir });
    await store.add({ ...questionSample });
    await assert.rejects(
      store.add({ ...questionSample }),
      (err) => {
        assert.ok(err instanceof StorageError);
        assert.equal(err.code, "QUESTION_DUPLICATE_ID");
        return true;
      }
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("questionStore: update changes status and persists", async () => {
  const baseDir = await makeBase();
  try {
    const store = createQuestionStore({ baseDir });
    await store.add({ ...questionSample });
    const updated = await store.update("mysql-slow-sql", {
      status: "accepted",
      updatedAt: "2026-05-05"
    });
    assert.equal(updated.status, "accepted");

    const list = await store.list();
    assert.equal(list[0].status, "accepted");
    assert.equal(list[0].updatedAt, "2026-05-05");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("questionStore: corrupt pool file surfaces a visible error", async () => {
  const baseDir = await makeBase();
  try {
    await mkdir(join(baseDir, "questions"), { recursive: true });
    await writeFile(join(baseDir, "questions", "question_pool.json"), "{not json", "utf8");

    const store = createQuestionStore({ baseDir });
    await assert.rejects(store.list(), StorageError);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

const attemptSample = Object.freeze({
  attemptId: "attempt-001",
  questionId: "mysql-slow-sql",
  answer: "我会先看慢查询日志,然后用 explain 看执行计划...",
  createdAt: "2026-05-04T10:00:00Z",
  status: "answered"
});

test("attemptStore: append + listByQuestion round-trip", async () => {
  const baseDir = await makeBase();
  try {
    const store = createAttemptStore({ baseDir });
    await store.append({ ...attemptSample });
    await store.append({ ...attemptSample, attemptId: "attempt-002", answer: "重答版本..." });

    const list = await store.listByQuestion("mysql-slow-sql");
    assert.equal(list.length, 2);
    assert.equal(list[0].attemptId, "attempt-001");
    assert.equal(list[1].attemptId, "attempt-002");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("attemptStore: filtering by questionId leaves other questions alone", async () => {
  const baseDir = await makeBase();
  try {
    const store = createAttemptStore({ baseDir });
    await store.append({ ...attemptSample });
    await store.append({
      ...attemptSample,
      attemptId: "attempt-other",
      questionId: "redis-hot-key"
    });

    const mysql = await store.listByQuestion("mysql-slow-sql");
    const redis = await store.listByQuestion("redis-hot-key");
    assert.equal(mysql.length, 1);
    assert.equal(redis.length, 1);
    assert.equal(mysql[0].attemptId, "attempt-001");
    assert.equal(redis[0].attemptId, "attempt-other");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

const cardSample = Object.freeze({
  id: "mysql-slow-sql-troubleshooting",
  title: "线上慢 SQL 排查",
  count: 0,
  category: "MySQL",
  tags: ["MySQL"],
  difficulty: "medium",
  createdAt: "2026-05-04",
  updatedAt: "2026-05-04",
  question: "线上慢 SQL 怎么排查?",
  myAnswer: "完整闭环回答...",
  feedbackPromptVersion: "interview-coach-v2",
  feedback: {
    performanceScore: {
      scores: {
        technicalCorrectness: 8,
        coverageCompleteness: 7,
        logicalStructure: 8,
        expressionClarity: 8,
        interviewPerformance: 7
      },
      overallComment: "good"
    }
  }
});

test("cardStore: save creates the file and updates the index", async () => {
  const baseDir = await makeBase();
  try {
    const store = createCardStore({ baseDir });
    await store.save({ ...cardSample });

    const got = await store.getById("mysql-slow-sql-troubleshooting");
    assert.equal(got.title, "线上慢 SQL 排查");

    const index = await store.listIndex();
    assert.deepEqual(index, ["mysql-slow-sql-troubleshooting.json"]);

    const onDisk = JSON.parse(
      await readFile(join(baseDir, "cards", "mysql-slow-sql-troubleshooting.json"), "utf8")
    );
    assert.equal(onDisk.id, "mysql-slow-sql-troubleshooting");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("cardStore: re-saving the same id does not duplicate index entries", async () => {
  const baseDir = await makeBase();
  try {
    const store = createCardStore({ baseDir });
    await store.save({ ...cardSample });
    await store.save({ ...cardSample, count: 1 });

    const index = await store.listIndex();
    assert.equal(index.length, 1);
    const got = await store.getById("mysql-slow-sql-troubleshooting");
    assert.equal(got.count, 1);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("cardStore: rejects ids with unsafe characters", async () => {
  const baseDir = await makeBase();
  try {
    const store = createCardStore({ baseDir });
    // ValidationError fires inside validateCardRecord before save() reaches
    // the path resolver. Either ValidationError or StorageError is acceptable
    // — both surface a visible failure.
    await assert.rejects(
      store.save({ ...cardSample, id: "mysql/../escape" }),
      (err) => err instanceof ValidationError || err instanceof StorageError
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("cardStore: getById returns null for unknown id (safe id)", async () => {
  const baseDir = await makeBase();
  try {
    const store = createCardStore({ baseDir });
    const got = await store.getById("nonexistent-id");
    assert.equal(got, null);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("cardStore: empty index returns []", async () => {
  const baseDir = await makeBase();
  try {
    const store = createCardStore({ baseDir });
    assert.deepEqual(await store.listIndex(), []);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// questionStore.remove / removeWhere (Phase A persistence improvements)
// ---------------------------------------------------------------------------

test("questionStore.remove: deletes a record by id and returns { removed: true }", async () => {
  const baseDir = await makeBase();
  try {
    const store = createQuestionStore({ baseDir });
    await store.add({ ...questionSample });
    const result = await store.remove("mysql-slow-sql");
    assert.deepEqual(result, { removed: true });
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("questionStore.remove: missing id returns { removed: false } (idempotent)", async () => {
  const baseDir = await makeBase();
  try {
    const store = createQuestionStore({ baseDir });
    const result = await store.remove("does-not-exist");
    assert.deepEqual(result, { removed: false });
    // Calling on a populated store but with an unknown id is also idempotent.
    await store.add({ ...questionSample });
    const result2 = await store.remove("still-not-here");
    assert.deepEqual(result2, { removed: false });
    const list = await store.list();
    assert.equal(list.length, 1);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("questionStore.removeWhere: removes only records matching predicate", async () => {
  const baseDir = await makeBase();
  try {
    const store = createQuestionStore({ baseDir });
    await store.add({ ...questionSample, id: "q1", status: "candidate" });
    await store.add({ ...questionSample, id: "q2", status: "ignored" });
    await store.add({ ...questionSample, id: "q3", status: "ignored" });
    await store.add({ ...questionSample, id: "q4", status: "accepted" });
    const result = await store.removeWhere((q) => q.status === "ignored");
    assert.equal(result.removedCount, 2);
    const list = await store.list();
    assert.deepEqual(
      list.map((q) => q.id).sort(),
      ["q1", "q4"]
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("questionStore.removeWhere: returns removedCount: 0 when nothing matches", async () => {
  const baseDir = await makeBase();
  try {
    const store = createQuestionStore({ baseDir });
    await store.add({ ...questionSample });
    const result = await store.removeWhere((q) => q.status === "ignored");
    assert.deepEqual(result, { removedCount: 0 });
    const list = await store.list();
    assert.equal(list.length, 1);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("questionStore.removeWhere: predicate must be a function", async () => {
  const baseDir = await makeBase();
  try {
    const store = createQuestionStore({ baseDir });
    await assert.rejects(store.removeWhere(null), StorageError);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// crawlCursorStore (used by per-day fetch advancement)
// ---------------------------------------------------------------------------

test("crawlCursorStore: get on missing key returns nextOffset: 0", async () => {
  const baseDir = await makeBase();
  try {
    const store = createCrawlCursorStore({ baseDir });
    const cursor = await store.get("feed-__feed__-2026-05-06");
    assert.equal(cursor.nextOffset, 0);
    assert.equal(cursor.updatedAt, null);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("crawlCursorStore: set then get round-trip preserves nextOffset", async () => {
  const baseDir = await makeBase();
  try {
    const store = createCrawlCursorStore({ baseDir });
    await store.set("feed-__feed__-2026-05-06", { nextOffset: 4 });
    const got = await store.get("feed-__feed__-2026-05-06");
    assert.equal(got.nextOffset, 4);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("crawlCursorStore: reset returns nextOffset to 0", async () => {
  const baseDir = await makeBase();
  try {
    const store = createCrawlCursorStore({ baseDir });
    await store.set("feed-__feed__-2026-05-06", { nextOffset: 4 });
    await store.reset("feed-__feed__-2026-05-06");
    const got = await store.get("feed-__feed__-2026-05-06");
    assert.equal(got.nextOffset, 0);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("crawlCursorStore: write is atomic (no half files left if rename never happened)", async () => {
  // We can't easily kill the process mid-write, but we can confirm the
  // tmp-then-rename pattern leaves no .tmp orphan after a successful set.
  const baseDir = await makeBase();
  try {
    const store = createCrawlCursorStore({ baseDir });
    await store.set("feed-__feed__-2026-05-06", { nextOffset: 7 });
    const dir = join(baseDir, "crawl-cursors");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    const tmps = entries.filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(tmps, []);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
