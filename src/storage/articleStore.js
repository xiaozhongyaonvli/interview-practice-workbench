// ArticleStore — append-only persistence for ArticleRecord.
//
// One JSONL file per query, scoped under <baseDir>/articles/<safeQuery>.jsonl.
// The query is sanitized so it cannot escape the articles directory — only
// letters, digits, underscore, and dash are kept. Empty / unsafe queries
// fall through to "default" rather than mounting a path traversal surface.

import { join } from "node:path";
import { validateArticleRecord } from "../domain/article.js";
import { StorageError } from "../domain/errors.js";
import { appendJsonlRecord, readJsonlRecords } from "./jsonlStore.js";

const SAFE_QUERY = /^[A-Za-z0-9_-]{1,64}$/;

function safeQueryName(query) {
  if (typeof query !== "string") {
    return "default";
  }
  if (SAFE_QUERY.test(query)) {
    return query;
  }
  // Strip every unsafe char; if nothing remains, fall back to "default".
  const stripped = query.replace(/[^A-Za-z0-9_-]/g, "");
  return stripped.length > 0 ? stripped.slice(0, 64) : "default";
}

export function createArticleStore({ baseDir }) {
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new StorageError("baseDir is required", { code: "STORE_CONFIG_INVALID" });
  }

  const articlesDir = join(baseDir, "articles");

  function pathForQuery(query) {
    return join(articlesDir, `${safeQueryName(query)}.jsonl`);
  }

  return {
    async append(record) {
      validateArticleRecord(record);
      const filePath = pathForQuery(record.query);
      await appendJsonlRecord(filePath, record);
      return record;
    },

    async listByQuery(query) {
      const records = await readJsonlRecords(pathForQuery(query));
      // Re-validate on read to catch records written by older versions or
      // hand-edited files. Validation throws on the first bad record.
      for (const r of records) validateArticleRecord(r);
      return records;
    }
  };
}
