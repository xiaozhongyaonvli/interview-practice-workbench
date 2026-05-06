// QuestionStore — single-file persistence for the question pool.
//
// File: <baseDir>/questions/question_pool.json
// Shape: { questions: QuestionRecord[] }
//
// Step 1 only needs add/list/update; later steps will layer status filtering
// on top. Updates are last-write-wins and rewrite the whole file because the
// pool is bounded (humans don't generate millions of questions).

import { join } from "node:path";
import { validateQuestionRecord } from "../domain/question.js";
import { StorageError } from "../domain/errors.js";
import { readJsonObject, writeJsonObject } from "./jsonStore.js";

export function createQuestionStore({ baseDir }) {
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new StorageError("baseDir is required", { code: "STORE_CONFIG_INVALID" });
  }

  const filePath = join(baseDir, "questions", "question_pool.json");

  async function readAll() {
    const raw = await readJsonObject(filePath, { defaultValue: { questions: [] } });
    if (raw === null || typeof raw !== "object" || !Array.isArray(raw.questions)) {
      throw new StorageError("question_pool.json has unexpected shape", {
        code: "QUESTION_POOL_SHAPE_INVALID",
        path: filePath
      });
    }
    for (const q of raw.questions) validateQuestionRecord(q);
    return raw.questions;
  }

  async function writeAll(list) {
    await writeJsonObject(filePath, { questions: list });
  }

  return {
    async list() {
      return await readAll();
    },

    async add(record) {
      validateQuestionRecord(record);
      const list = await readAll();
      if (list.some((q) => q.id === record.id)) {
        throw new StorageError(`question id "${record.id}" already exists`, {
          code: "QUESTION_DUPLICATE_ID",
          path: filePath
        });
      }
      list.push(record);
      await writeAll(list);
      return record;
    },

    async update(id, patch) {
      const list = await readAll();
      const index = list.findIndex((q) => q.id === id);
      if (index < 0) {
        throw new StorageError(`question id "${id}" not found`, {
          code: "QUESTION_NOT_FOUND",
          path: filePath
        });
      }
      const merged = { ...list[index], ...patch, id, updatedAt: patch.updatedAt ?? list[index].updatedAt };
      validateQuestionRecord(merged);
      list[index] = merged;
      await writeAll(list);
      return merged;
    },

    // Idempotent removal. Returns { removed: false } when the id is not in
    // the pool; only storage write failures throw.
    async remove(id) {
      const list = await readAll();
      const index = list.findIndex((q) => q.id === id);
      if (index < 0) {
        return { removed: false };
      }
      const next = list.slice(0, index).concat(list.slice(index + 1));
      await writeAll(next);
      return { removed: true };
    },

    // Remove every record matching predicate in a single rewrite.
    async removeWhere(predicate) {
      if (typeof predicate !== "function") {
        throw new StorageError("removeWhere predicate must be a function", {
          code: "STORE_CONFIG_INVALID"
        });
      }
      const list = await readAll();
      const kept = [];
      let removedCount = 0;
      for (const q of list) {
        if (predicate(q)) {
          removedCount += 1;
        } else {
          kept.push(q);
        }
      }
      if (removedCount > 0) {
        await writeAll(kept);
      }
      return { removedCount };
    }
  };
}
