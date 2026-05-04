// CardStore — file-per-card persistence with an ordered index.
//
// Layout (mirrors the legacy cards/ directory):
//
//   <baseDir>/cards/<id>.json     one CardRecord per file
//   <baseDir>/cards/index.json    ["id-a.json", "id-b.json", ...]
//
// New cards prepend to the index so the most recently saved card surfaces
// first in the front-end list — matches the legacy front-end behavior.

import { join } from "node:path";
import { validateCardRecord } from "../domain/card.js";
import { StorageError } from "../domain/errors.js";
import { readJsonObject, writeJsonObject } from "./jsonStore.js";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function createCardStore({ baseDir }) {
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new StorageError("baseDir is required", { code: "STORE_CONFIG_INVALID" });
  }

  const cardsDir = join(baseDir, "cards");
  const indexPath = join(cardsDir, "index.json");

  function pathForId(id) {
    if (!SAFE_ID.test(id)) {
      throw new StorageError(`card id "${id}" contains unsafe characters`, {
        code: "CARD_ID_UNSAFE"
      });
    }
    return join(cardsDir, `${id}.json`);
  }

  async function readIndex() {
    const list = await readJsonObject(indexPath, { defaultValue: [] });
    if (!Array.isArray(list)) {
      throw new StorageError("cards/index.json must be an array", {
        code: "CARD_INDEX_SHAPE_INVALID",
        path: indexPath
      });
    }
    return list;
  }

  return {
    async save(record) {
      validateCardRecord(record);
      const filePath = pathForId(record.id);

      // Refuse to silently overwrite — Step 7 will allow explicit overwrite
      // by a separate code path. For now, idempotent re-save of the same id
      // is allowed because retry-then-save is a real workflow, but the index
      // must not gain duplicate entries.
      await writeJsonObject(filePath, record);

      const index = await readIndex();
      const filename = `${record.id}.json`;
      if (!index.includes(filename)) {
        index.unshift(filename);
        await writeJsonObject(indexPath, index);
      }

      return record;
    },

    async getById(id) {
      const filePath = pathForId(id);
      const json = await readJsonObject(filePath);
      if (json === null) return null;
      validateCardRecord(json);
      return json;
    },

    async listIndex() {
      return await readIndex();
    }
  };
}
