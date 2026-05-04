// AttemptRecord — one user answer for one question, optionally accompanied by
// an LLM scoring result. Multiple AttemptRecords share the same questionId so
// the retry loop can compare versions over time.
//
// AttemptRecord intentionally separates `answer` (always required) from
// `summary` (optional, present only after scoring). An attempt without a
// summary is in the "needs_rescore" state — the user has answered but the
// scoring step has not produced a valid response yet.
//
// Reference: phase-a-practice-loop-requirements 第 6.3 节,
// phase-a-implementation-plan Step 4 / Step 5.

import { ValidationError } from "./errors.js";
import { validateScoreSummary } from "./scoreSummary.js";

export const ATTEMPT_STATUSES = Object.freeze([
  "answered",
  "scored",
  "needs_rescore"
]);

function fail(path, message, value) {
  throw new ValidationError(`AttemptRecord.${path}: ${message}`, {
    code: "ATTEMPT_INVALID",
    path,
    value
  });
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateAttemptRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    fail("", "must be an object", record);
  }

  if (!isNonEmptyString(record.attemptId)) {
    fail("attemptId", "must be a non-empty string", record.attemptId);
  }

  if (!isNonEmptyString(record.questionId)) {
    fail("questionId", "must be a non-empty string", record.questionId);
  }

  if (!isNonEmptyString(record.answer)) {
    fail("answer", "must be a non-empty string", record.answer);
  }

  if (!isNonEmptyString(record.createdAt)) {
    fail("createdAt", "must be a non-empty ISO timestamp", record.createdAt);
  }

  if (!ATTEMPT_STATUSES.includes(record.status)) {
    fail(
      "status",
      `must be one of ${ATTEMPT_STATUSES.join(", ")}`,
      record.status
    );
  }

  if (record.status === "scored") {
    if (!isNonEmptyString(record.feedbackPromptVersion)) {
      fail(
        "feedbackPromptVersion",
        "is required for scored attempts",
        record.feedbackPromptVersion
      );
    }
    if (!record.summary) {
      fail("summary", "is required for scored attempts", record.summary);
    }
    // Delegate the strict gap-field check to ScoreSummary's validator so we
    // do not duplicate the rule.
    validateScoreSummary(record.summary);
  } else if (record.summary !== undefined && record.summary !== null) {
    // If a summary is present on a non-scored attempt, it must still be valid.
    validateScoreSummary(record.summary);
  }

  if (record.feedback !== undefined && record.feedback !== null) {
    if (typeof record.feedback !== "object" || Array.isArray(record.feedback)) {
      fail("feedback", "must be an object when present", record.feedback);
    }
  }

  return record;
}
