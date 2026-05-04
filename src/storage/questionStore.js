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
    }
  };
}
