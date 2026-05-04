// ArticleRecord — raw source material from NowCoder, manual paste, or future
// adapters. The training domain consumes ArticleRecord and never sees adapter-
// specific fields (HTML attributes, NowCoder metadata, etc.). New sources MUST
// translate into this shape inside their own adapter.
//
// Schema reference: phase-a-practice-loop-requirements 第 6.1 节,
// phase-a-implementation-plan Step 1.

import { ValidationError } from "./errors.js";

export const ARTICLE_SOURCES = Object.freeze(["nowcoder", "manual"]);

function fail(path, message, value) {
  throw new ValidationError(`ArticleRecord.${path}: ${message}`, {
    code: "ARTICLE_INVALID",
    path,
    value
  });
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate an ArticleRecord. Throws ValidationError on the first failure with
 * a structured `code` and `path`. Returns the input unchanged on success so
 * callers can write `const ok = validateArticleRecord(input)`.
 */
export function validateArticleRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    fail("", "must be an object", record);
  }

  if (!isNonEmptyString(record.id)) {
    fail("id", "must be a non-empty string", record.id);
  }

  if (!ARTICLE_SOURCES.includes(record.source)) {
    fail(
      "source",
      `must be one of ${ARTICLE_SOURCES.join(", ")}`,
      record.source
    );
  }

  if (!isNonEmptyString(record.query)) {
    fail("query", "must be a non-empty string", record.query);
  }

  if (!isNonEmptyString(record.title)) {
    fail("title", "must be a non-empty string", record.title);
  }

  if (!isNonEmptyString(record.text)) {
    fail("text", "must be a non-empty string", record.text);
  }

  if (!isNonEmptyString(record.fetchedAt)) {
    fail("fetchedAt", "must be a non-empty ISO date string", record.fetchedAt);
  }

  // sourceUrl is required for nowcoder, optional for manual paste.
  if (record.source === "nowcoder" && !isNonEmptyString(record.sourceUrl)) {
    fail("sourceUrl", "is required when source is nowcoder", record.sourceUrl);
  }
  if (record.sourceUrl !== undefined && record.sourceUrl !== null && typeof record.sourceUrl !== "string") {
    fail("sourceUrl", "must be a string when present", record.sourceUrl);
  }

  if (record.rawMetadata !== undefined && record.rawMetadata !== null) {
    if (typeof record.rawMetadata !== "object" || Array.isArray(record.rawMetadata)) {
      fail("rawMetadata", "must be an object when present", record.rawMetadata);
    }
  }

  return record;
}
