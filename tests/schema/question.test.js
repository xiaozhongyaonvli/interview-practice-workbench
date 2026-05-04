import assert from "node:assert/strict";
import test from "node:test";
import { validateQuestionRecord, QUESTION_STATUSES } from "../../src/domain/question.js";
import { ValidationError } from "../../src/domain/errors.js";

const baseQuestion = Object.freeze({
  id: "mysql-slow-sql-troubleshooting",
  question: "线上出现慢 SQL，怎么排查？",
  category: "MySQL",
  tags: ["MySQL", "性能"],
  difficulty: "medium",
  source: "nowcoder",
  sourceUrl: "https://www.nowcoder.com/discuss/1",
  sourceTitle: "字节二面 MySQL",
  evidence: "面试官问了慢 SQL 排查的完整链路...",
  query: "mysql",
  confidence: 0.86,
  status: "candidate",
  createdAt: "2026-05-04",
  updatedAt: "2026-05-04"
});

test("validates a complete QuestionRecord", () => {
  assert.doesNotThrow(() => validateQuestionRecord({ ...baseQuestion }));
});

test("rejects a category that is not in the allowed list", () => {
  const bad = { ...baseQuestion, category: "前端" };
  assert.throws(
    () => validateQuestionRecord(bad),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, "QUESTION_INVALID");
      assert.equal(err.path, "category");
      return true;
    }
  );
});

test("accepts both English and Chinese difficulty labels", () => {
  for (const label of ["easy", "medium", "hard", "简单", "中等", "困难"]) {
    assert.doesNotThrow(
      () => validateQuestionRecord({ ...baseQuestion, difficulty: label }),
      `difficulty=${label} should pass`
    );
  }
});

test("rejects an unknown difficulty label", () => {
  assert.throws(
    () => validateQuestionRecord({ ...baseQuestion, difficulty: "extreme" }),
    ValidationError
  );
});

test("rejects a status that is not in the documented state machine", () => {
  const bad = { ...baseQuestion, status: "wip" };
  assert.throws(
    () => validateQuestionRecord(bad),
    (err) => {
      assert.equal(err.path, "status");
      return true;
    }
  );
});

test("rejects an out-of-range confidence", () => {
  for (const value of [-0.1, 1.5, Number.NaN]) {
    assert.throws(
      () => validateQuestionRecord({ ...baseQuestion, confidence: value }),
      ValidationError,
      `confidence=${value} should be rejected`
    );
  }
});

test("rejects an id that contains unsafe characters", () => {
  const bad = { ...baseQuestion, id: "mysql/慢 sql" };
  assert.throws(() => validateQuestionRecord(bad), ValidationError);
});

test("rejects tags that are not strings", () => {
  const bad = { ...baseQuestion, tags: ["MySQL", 42] };
  assert.throws(() => validateQuestionRecord(bad), ValidationError);
});

test("QUESTION_STATUSES is locked to the documented state machine", () => {
  assert.deepEqual(
    [...QUESTION_STATUSES],
    ["candidate", "accepted", "ignored", "duplicate", "mastered"]
  );
});
