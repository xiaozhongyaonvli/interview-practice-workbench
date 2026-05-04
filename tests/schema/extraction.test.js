import assert from "node:assert/strict";
import test from "node:test";
import {
  validateExtractionResult,
  extractionItemToQuestionRecord
} from "../../src/domain/extraction.js";
import { validateQuestionRecord } from "../../src/domain/question.js";
import { ValidationError } from "../../src/domain/errors.js";

const validExtraction = Object.freeze({
  questions: [
    {
      question: "线上出现慢 SQL,怎么排查?",
      category: "MySQL",
      difficulty: "medium",
      evidence: "面试官问了慢日志和 explain",
      confidence: 0.86
    },
    {
      question: "InnoDB 的 ACID 怎么保证?",
      category: "MySQL",
      difficulty: "hard",
      confidence: 0.9
    }
  ]
});

test("validates a complete extraction result", () => {
  assert.doesNotThrow(() => validateExtractionResult({ ...validExtraction }));
});

test("rejects an extraction missing the questions array", () => {
  const bad = { count: 0 };
  assert.throws(
    () => validateExtractionResult(bad),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, "EXTRACTION_INVALID");
      assert.equal(err.path, "questions");
      return true;
    }
  );
});

test("rejects an extraction whose questions array is empty", () => {
  assert.throws(
    () => validateExtractionResult({ questions: [] }),
    (err) => {
      assert.equal(err.path, "questions");
      return true;
    }
  );
});

test("rejects an item missing the question field", () => {
  const bad = {
    questions: [{ category: "MySQL", difficulty: "medium", confidence: 0.7 }]
  };
  assert.throws(
    () => validateExtractionResult(bad),
    (err) => {
      assert.equal(err.path, "questions[0].question");
      return true;
    }
  );
});

test("rejects an item with an unknown category", () => {
  const bad = {
    questions: [
      { question: "Q?", category: "前端", difficulty: "medium", confidence: 0.5 }
    ]
  };
  assert.throws(() => validateExtractionResult(bad), (err) => {
    assert.equal(err.path, "questions[0].category");
    return true;
  });
});

test("rejects an item flagged as non-technical", () => {
  const bad = {
    questions: [
      {
        question: "你为什么离职?",
        category: "MySQL", // category itself is not the issue; isTechnical is
        difficulty: "easy",
        confidence: 0.9,
        isTechnical: false
      }
    ]
  };
  assert.throws(() => validateExtractionResult(bad), (err) => {
    assert.equal(err.path, "questions[0].isTechnical");
    return true;
  });
});

test("rejects an item with confidence outside [0, 1]", () => {
  const bad = {
    questions: [{ question: "Q?", category: "MySQL", difficulty: "medium", confidence: 1.5 }]
  };
  assert.throws(() => validateExtractionResult(bad), (err) => {
    assert.equal(err.path, "questions[0].confidence");
    return true;
  });
});

test("extractionItemToQuestionRecord produces a record that passes validateQuestionRecord", () => {
  const item = {
    question: "线上出现慢 SQL,怎么排查?",
    category: "MySQL",
    difficulty: "medium",
    confidence: 0.86,
    evidence: "面试官提及"
  };
  const record = extractionItemToQuestionRecord(
    item,
    { query: "mysql", source: "manual", sourceUrl: null, sourceTitle: null },
    { now: "2026-05-04T10:00:00Z" }
  );
  assert.doesNotThrow(() => validateQuestionRecord(record));
  assert.equal(record.status, "candidate");
  assert.equal(record.query, "mysql");
  assert.equal(record.category, "MySQL");
  assert.match(record.id, /^mysql-/);
});

test("extractionItemToQuestionRecord falls back to a hash id when the question is non-ASCII only", () => {
  const item = {
    question: "MVCC 怎么工作?",
    category: "MySQL",
    difficulty: "hard",
    confidence: 0.9
  };
  const record = extractionItemToQuestionRecord(
    item,
    { query: "mysql", source: "manual" },
    { now: "2026-05-04T10:00:00Z" }
  );
  assert.match(record.id, /^mysql-/);
  assert.doesNotThrow(() => validateQuestionRecord(record));
});

test("extractionItemToQuestionRecord adds the category as a tag", () => {
  const item = {
    question: "Q?",
    category: "Redis",
    difficulty: "medium",
    confidence: 0.7
  };
  const record = extractionItemToQuestionRecord(
    item,
    { query: "redis", source: "manual" },
    { now: "2026-05-04T10:00:00Z" }
  );
  assert.ok(record.tags.includes("Redis"));
});
