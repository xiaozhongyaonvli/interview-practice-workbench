// HTTP layer helpers shared across api/* modules.
//
// Body parsing limits are conservative — manual article paste should never
// exceed ~1 MB of plain text in practice. Hard-fail on larger payloads so a
// runaway client cannot exhaust memory.

import { ValidationError, StorageError } from "../domain/errors.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/**
 * Read the request body and parse it as JSON. Throws ValidationError on
 * oversized bodies, malformed JSON, or non-object roots so route handlers
 * can rely on `body` being a plain object.
 */
export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new ValidationError("request body exceeds 1 MiB", {
        code: "BODY_TOO_LARGE"
      });
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError("request body is not valid JSON", {
      code: "BODY_NOT_JSON"
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("request body must be a JSON object", {
      code: "BODY_NOT_OBJECT"
    });
  }
  return parsed;
}

/**
 * Map a thrown error to an HTTP status code + JSON payload.
 *
 * - ValidationError (user input)         -> 400
 * - StorageError with documented user
 *   error codes (DUPLICATE_ID etc.)      -> 409
 * - StorageError otherwise               -> 500
 * - Anything else                        -> 500 with generic message
 *
 * The payload always carries `error` (human-readable) and, when available,
 * `code` and `path` so the front-end can pick a localized message.
 */
const USER_FACING_STORAGE_CODES = new Set([
  "QUESTION_DUPLICATE_ID",
  "QUESTION_NOT_FOUND",
  "CARD_ID_UNSAFE"
]);

export function errorToHttp(err) {
  if (err instanceof ValidationError) {
    return {
      status: 400,
      body: {
        error: err.message,
        code: err.code,
        path: err.path
      }
    };
  }
  if (err instanceof StorageError) {
    if (USER_FACING_STORAGE_CODES.has(err.code)) {
      return {
        status: 409,
        body: { error: err.message, code: err.code }
      };
    }
    return {
      status: 500,
      body: { error: err.message, code: err.code }
    };
  }
  return {
    status: 500,
    body: { error: "internal server error", code: "INTERNAL_ERROR" }
  };
}

export function sendError(res, err) {
  const { status, body } = errorToHttp(err);
  sendJson(res, status, body);
}
