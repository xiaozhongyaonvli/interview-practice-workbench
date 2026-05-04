// Attempt API — POST a new answer, GET attempts for one question.
//
// Each new answer is its own AttemptRecord; we never edit history. The retry
// loop in Step 6 selects a "best" by sorting these records, so creation
// order must be preserved.

import { ValidationError } from "../domain/errors.js";
import { readJsonBody, sendJson, sendError } from "./http.js";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function nowIso() {
  return new Date().toISOString();
}

function randomSuffix() {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function generateAttemptId() {
  // attempt-<base36 timestamp>-<8 hex random>
  return `attempt-${Date.now().toString(36)}-${randomSuffix()}`;
}

function requireString(value, field, code = "ATTEMPT_INPUT_INVALID") {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`, {
      code,
      path: field
    });
  }
}

export function createAttemptApi({ attemptStore, now = nowIso }) {
  if (!attemptStore) throw new Error("createAttemptApi: attemptStore is required");

  async function handleCreate(req, res) {
    try {
      const body = await readJsonBody(req);
      requireString(body.questionId, "questionId");
      if (!SAFE_ID.test(body.questionId)) {
        throw new ValidationError("questionId must contain only A-Za-z0-9_-", {
          code: "ATTEMPT_INPUT_INVALID",
          path: "questionId"
        });
      }
      requireString(body.answer, "answer");

      const record = {
        attemptId: generateAttemptId(),
        questionId: body.questionId,
        answer: body.answer,
        createdAt: now(),
        // Fresh attempts start in the "answered" state. Step 5 transitions
        // them to "scored" (or "needs_rescore" on validation failure).
        status: "answered"
      };

      const saved = await attemptStore.append(record);
      sendJson(res, 201, saved);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleList(req, res, url) {
    try {
      const questionId = url.searchParams.get("questionId");
      requireString(questionId, "questionId");
      if (!SAFE_ID.test(questionId)) {
        throw new ValidationError("questionId must contain only A-Za-z0-9_-", {
          code: "ATTEMPT_INPUT_INVALID",
          path: "questionId"
        });
      }
      const records = await attemptStore.listByQuestion(questionId);
      // Oldest first matches the "history" reading order; the front-end
      // can reverse if it wants newest at the top.
      records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      sendJson(res, 200, { attempts: records });
    } catch (err) {
      sendError(res, err);
    }
  }

  return { handleCreate, handleList };
}
