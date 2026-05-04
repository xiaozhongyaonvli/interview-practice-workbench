import assert from "node:assert/strict";
import test from "node:test";
import { validateArticleRecord, ARTICLE_SOURCES } from "../../src/domain/article.js";
import { ValidationError } from "../../src/domain/errors.js";

const validNowcoder = Object.freeze({
  id: "nowcoder-mysql-001",
  source: "nowcoder",
  sourceUrl: "https://www.nowcoder.com/discuss/1",
  query: "mysql",
  title: "字节二面 MySQL 面经",
  text: "面试官问了 InnoDB 的 ACID 怎么保证...",
  fetchedAt: "2026-05-04T10:00:00Z"
});

const validManual = Object.freeze({
  id: "manual-mysql-002",
  source: "manual",
  query: "mysql",
  title: "我从微信群粘贴的一段面经",
  text: "面试官 1: 索引失效有哪些情况...",
  fetchedAt: "2026-05-04T11:00:00Z"
});

test("validates a complete nowcoder ArticleRecord", () => {
  assert.doesNotThrow(() => validateArticleRecord({ ...validNowcoder }));
});

test("validates a complete manual ArticleRecord (no sourceUrl required)", () => {
  const result = validateArticleRecord({ ...validManual });
  assert.equal(result.source, "manual");
});

test("rejects a record whose source is neither nowcoder nor manual", () => {
  const bad = { ...validNowcoder, source: "csdn" };
  assert.throws(
    () => validateArticleRecord(bad),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, "ARTICLE_INVALID");
      assert.equal(err.path, "source");
      return true;
    }
  );
});

test("rejects a nowcoder record without sourceUrl", () => {
  const bad = { ...validNowcoder };
  delete bad.sourceUrl;
  assert.throws(
    () => validateArticleRecord(bad),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.path, "sourceUrl");
      return true;
    }
  );
});

test("rejects a record with empty text", () => {
  const bad = { ...validManual, text: "   " };
  assert.throws(() => validateArticleRecord(bad), ValidationError);
});

test("rejects non-object inputs", () => {
  assert.throws(() => validateArticleRecord(null), ValidationError);
  assert.throws(() => validateArticleRecord("a string"), ValidationError);
  assert.throws(() => validateArticleRecord([]), ValidationError);
});

test("ARTICLE_SOURCES is locked to the documented set", () => {
  assert.deepEqual([...ARTICLE_SOURCES], ["nowcoder", "manual"]);
});
