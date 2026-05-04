// QuestionRecord — a candidate interview question extracted from one or more
// ArticleRecords (or hand-entered). Lives in the question pool; later steps
// progress it through `accepted` / `ignored` / `mastered` as the user trains.
//
// Schema reference: phase-a-practice-loop-requirements 第 6.2 节.

import { ValidationError } from "./errors.js";
import { isAllowedCategory } from "./categories.js";
import { isAllowedDifficulty } from "./difficulty.js";

export const QUESTION_STATUSES = Object.freeze([
  "candidate",
  "accepted",
  "ignored",
  "duplicate",
  "mastered"
]);

function fail(path, message, value) {
  throw new ValidationError(`QuestionRecord.${path}: ${message}`, {
    code: "QUESTION_INVALID",
    path,
    value
  });
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateQuestionRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    fail("", "must be an object", record);
  }

  if (!isNonEmptyString(record.id)) {
    fail("id", "must be a non-empty string", record.id);
  }

  if (!/^[A-Za-z0-9_-]+$/.test(record.id)) {
    fail("id", "may only contain letters, digits, underscore, and dash", record.id);
  }

  if (!isNonEmptyString(record.question)) {
    fail("question", "must be a non-empty string", record.question);
  }

  if (!isAllowedCategory(record.category)) {
    fail("category", "is not in the allowed category list", record.category);
  }

  if (!Array.isArray(record.tags)) {
    fail("tags", "must be an array of strings", record.tags);
  }
  for (const tag of record.tags) {
    if (typeof tag !== "string") {
      fail("tags", "every tag must be a string", tag);
    }
  }

  if (!isAllowedDifficulty(record.difficulty)) {
    fail("difficulty", "must be easy/medium/hard or 简单/中等/困难", record.difficulty);
  }

  if (typeof record.confidence !== "number" || Number.isNaN(record.confidence)) {
    fail("confidence", "must be a number", record.confidence);
  }
  if (record.confidence < 0 || record.confidence > 1) {
    fail("confidence", "must be between 0 and 1 (inclusive)", record.confidence);
  }

  if (!QUESTION_STATUSES.includes(record.status)) {
    fail(
      "status",
      `must be one of ${QUESTION_STATUSES.join(", ")}`,
      record.status
    );
  }

  if (!isNonEmptyString(record.query)) {
    fail("query", "must be a non-empty string", record.query);
  }

  // Source provenance is required so the user can trace back to the article.
  if (!isNonEmptyString(record.source)) {
    fail("source", "must be a non-empty string", record.source);
  }

  if (record.evidence !== undefined && record.evidence !== null && typeof record.evidence !== "string") {
    fail("evidence", "must be a string when present", record.evidence);
  }

  if (!isNonEmptyString(record.createdAt)) {
    fail("createdAt", "must be a non-empty date string", record.createdAt);
  }
  if (!isNonEmptyString(record.updatedAt)) {
    fail("updatedAt", "must be a non-empty date string", record.updatedAt);
  }

  return record;
}
