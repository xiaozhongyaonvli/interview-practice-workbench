// ArticleStore — append-only persistence for ArticleRecord.
//
// One JSONL file per query, scoped under <baseDir>/articles/<safeQuery>.jsonl.
// The query is sanitized so it cannot escape the articles directory. ASCII
// queries ([A-Za-z0-9_-]) map to themselves; non-ASCII queries (e.g. 面经)
// are percent-encoded and made fs-safe so different Chinese queries land in
// different files — not all collapsed into a single `default.jsonl` bucket.

import { join } from "node:path";
import { readdir, writeFile, rename } from "node:fs/promises";
import { validateArticleRecord } from "../domain/article.js";
import { StorageError } from "../domain/errors.js";
import { appendJsonlRecord, readJsonlRecords } from "./jsonlStore.js";

const SAFE_QUERY = /^[A-Za-z0-9_-]{1,64}$/;

function safeQueryName(query) {
  if (typeof query !== "string" || query.length === 0) return "default";
  if (SAFE_QUERY.test(query)) return query;
  // Percent-encode the query (UTF-8 aware) and replace `%` with `_` so the
  // result is filesystem-safe while still deterministic: the same query
  // always hashes to the same filename, so listByQuery and append agree.
  const encoded = encodeURIComponent(query)
    .replace(/%/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "");
  return encoded.length > 0 ? encoded.slice(0, 64) : "default";
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
    },

    // Drop ArticleRecord rows whose source matches and fetchedAt is older
    // than `days * 86400000` ms. Manual records ignore the TTL — they are
    // user-pasted assets, not regenerable. Walks every per-query file under
    // <baseDir>/articles/, rewrites in place via tmp+rename so a crash mid-
    // prune cannot leave a half-written file. Returns counts for the caller
    // to log; failures inside one file do not abort the others.
    async pruneOlderThan({ days, source } = {}) {
      if (!Number.isFinite(days) || days <= 0) {
        throw new StorageError("pruneOlderThan: days must be a positive number", {
          code: "STORE_CONFIG_INVALID"
        });
      }
      if (typeof source !== "string" || source.length === 0) {
        throw new StorageError("pruneOlderThan: source is required", {
          code: "STORE_CONFIG_INVALID"
        });
      }
      const cutoffMs = Date.now() - days * 86400000;
      let files;
      try {
        files = await readdir(articlesDir);
      } catch (err) {
        if (err && err.code === "ENOENT") return { removedCount: 0, keptCount: 0 };
        throw new StorageError("pruneOlderThan: failed to list articles dir", {
          code: "JSONL_READ_FAILED",
          cause: err,
          path: articlesDir
        });
      }

      let removedCount = 0;
      let keptCount = 0;

      for (const fname of files) {
        if (!fname.endsWith(".jsonl")) continue;
        const filePath = join(articlesDir, fname);
        const records = await readJsonlRecords(filePath);
        const kept = [];
        for (const r of records) {
          if (r.source !== source) {
            kept.push(r);
            continue;
          }
          const ts = Date.parse(r.fetchedAt);
          if (Number.isNaN(ts) || ts >= cutoffMs) {
            kept.push(r);
          } else {
            removedCount += 1;
          }
        }
        keptCount += kept.length;

        if (kept.length === records.length) continue;
        const tmpPath = `${filePath}.tmp`;
        const body = kept.length === 0 ? "" : kept.map((r) => JSON.stringify(r)).join("\n") + "\n";
        try {
          await writeFile(tmpPath, body, "utf8");
          await rename(tmpPath, filePath);
        } catch (cause) {
          throw new StorageError("pruneOlderThan: failed to rewrite file", {
            code: "JSONL_APPEND_FAILED",
            cause,
            path: filePath
          });
        }
      }

      return { removedCount, keptCount };
    }
  };
}
