// ScoreStore — append-only log of LLM scoring results, indexed by attemptId.
//
// Scoring is intentionally NOT a mutation on AttemptRecord. Attempts are
// answer snapshots; scoring is an after-the-fact annotation. Re-scoring an
// attempt simply appends a new ScoreRecord so the user can see how the
// validation outcome changed.
//
// Layout: <baseDir>/scores/scores.jsonl

import { join } from "node:path";
import { validateScoreSummary } from "../domain/scoreSummary.js";
import { ValidationError, StorageError } from "../domain/errors.js";
import { appendJsonlRecord, readJsonlRecords } from "./jsonlStore.js";

export function createScoreStore({ baseDir }) {
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new StorageError("baseDir is required", { code: "STORE_CONFIG_INVALID" });
  }

  const filePath = join(baseDir, "scores", "scores.jsonl");

  return {
    async append(record) {
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw new ValidationError("ScoreRecord must be an object", {
          code: "SCORE_INVALID",
          path: ""
        });
      }
      if (typeof record.attemptId !== "string" || record.attemptId.length === 0) {
        throw new ValidationError("ScoreRecord.attemptId is required", {
          code: "SCORE_INVALID",
          path: "attemptId"
        });
      }
      if (typeof record.scoredAt !== "string" || record.scoredAt.length === 0) {
        throw new ValidationError("ScoreRecord.scoredAt is required", {
          code: "SCORE_INVALID",
          path: "scoredAt"
        });
      }
      if (typeof record.feedbackPromptVersion !== "string" || record.feedbackPromptVersion.length === 0) {
        throw new ValidationError("ScoreRecord.feedbackPromptVersion is required", {
          code: "SCORE_INVALID",
          path: "feedbackPromptVersion"
        });
      }
      validateScoreSummary(record.summary);
      // feedback is optional but, when present, must be an object so the
      // front-end can render the long-form sections.
      if (record.feedback !== undefined && record.feedback !== null) {
        if (typeof record.feedback !== "object" || Array.isArray(record.feedback)) {
          throw new ValidationError("ScoreRecord.feedback must be an object when present", {
            code: "SCORE_INVALID",
            path: "feedback"
          });
        }
      }

      await appendJsonlRecord(filePath, record);
      return record;
    },

    async listByAttempt(attemptId) {
      const all = await readJsonlRecords(filePath);
      return all.filter((r) => r.attemptId === attemptId);
    },

    async latestForAttempt(attemptId) {
      const list = await this.listByAttempt(attemptId);
      if (list.length === 0) return null;
      // Latest by scoredAt; fall back to file order on ties.
      return list.reduce((acc, cur) =>
        acc === null || String(cur.scoredAt).localeCompare(String(acc.scoredAt)) >= 0 ? cur : acc, null);
    },

    async latestByAttemptIds(ids) {
      const all = await readJsonlRecords(filePath);
      const map = new Map();
      for (const r of all) {
        if (!ids.includes(r.attemptId)) continue;
        const prev = map.get(r.attemptId);
        if (!prev || String(r.scoredAt).localeCompare(String(prev.scoredAt)) >= 0) {
          map.set(r.attemptId, r);
        }
      }
      return map;
    },

    async removeByAttemptId(attemptId) {
      if (typeof attemptId !== "string" || attemptId.length === 0) {
        throw new StorageError("attemptId is required", {
          code: "SCORE_QUERY_INVALID"
        });
      }
      const all = await readJsonlRecords(filePath);
      const kept = all.filter((r) => r.attemptId !== attemptId);
      const removedCount = all.length - kept.length;
      if (removedCount === 0) {
        return { removedCount: 0 };
      }
      const { writeFile, rename, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      const body = kept.map((record) => JSON.stringify(record)).join("\n");
      await writeFile(tmpPath, body.length > 0 ? `${body}\n` : "", "utf8");
      await rename(tmpPath, filePath);
      return { removedCount };
    }
  };
}
