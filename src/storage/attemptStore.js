// AttemptStore — append-only log of user answer attempts and their scores.
//
// File: <baseDir>/attempts/attempts.jsonl
// One line per attempt. Attempts are never edited in place — a re-score
// generates a new AttemptRecord with the same questionId so history stays
// honest. Step 6 will read all attempts and group by questionId.

import { join } from "node:path";
import { validateAttemptRecord } from "../domain/attempt.js";
import { StorageError } from "../domain/errors.js";
import { appendJsonlRecord, readJsonlRecords } from "./jsonlStore.js";

export function createAttemptStore({ baseDir }) {
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new StorageError("baseDir is required", { code: "STORE_CONFIG_INVALID" });
  }

  const filePath = join(baseDir, "attempts", "attempts.jsonl");

  return {
    async append(record) {
      validateAttemptRecord(record);
      await appendJsonlRecord(filePath, record);
      return record;
    },

    async listAll() {
      const records = await readJsonlRecords(filePath);
      for (const r of records) validateAttemptRecord(r);
      return records;
    },

    async listByQuestion(questionId) {
      if (typeof questionId !== "string" || questionId.length === 0) {
        throw new StorageError("questionId is required", {
          code: "ATTEMPT_QUERY_INVALID"
        });
      }
      const all = await this.listAll();
      return all.filter((r) => r.questionId === questionId);
    },

    async remove(attemptId) {
      if (typeof attemptId !== "string" || attemptId.length === 0) {
        throw new StorageError("attemptId is required", {
          code: "ATTEMPT_QUERY_INVALID"
        });
      }
      const all = await this.listAll();
      const kept = all.filter((r) => r.attemptId !== attemptId);
      if (kept.length === all.length) {
        return { removed: false };
      }
      const { writeFile, rename, rm, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      const body = kept.map((record) => JSON.stringify(record)).join("\n");
      await writeFile(tmpPath, body.length > 0 ? `${body}\n` : "", "utf8");
      await rename(tmpPath, filePath);
      return { removed: true };
    }
  };
}
