import { join } from "node:path";
import { readJsonObject, writeJsonObject } from "./jsonStore.js";
import { StorageError } from "../domain/errors.js";

const SAFE_KEY = /^[A-Za-z0-9_-]{1,96}$/;

function safeCursorKey(key) {
  if (typeof key !== "string" || key.length === 0) return "default";
  if (SAFE_KEY.test(key)) return key;
  const encoded = encodeURIComponent(key)
    .replace(/%/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "");
  return encoded.length > 0 ? encoded.slice(0, 96) : "default";
}

export function createCrawlCursorStore({ baseDir }) {
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new StorageError("baseDir is required", { code: "STORE_CONFIG_INVALID" });
  }

  const cursorDir = join(baseDir, "crawl-cursors");

  function pathForKey(key) {
    return join(cursorDir, `${safeCursorKey(key)}.json`);
  }

  return {
    async get(key) {
      const value = await readJsonObject(pathForKey(key), {
        defaultValue: {
          key,
          nextOffset: 0,
          updatedAt: null
        }
      });
      if (!Number.isInteger(value.nextOffset) || value.nextOffset < 0) {
        return { key, nextOffset: 0, updatedAt: null };
      }
      return {
        key,
        nextOffset: value.nextOffset,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null
      };
    },

    async set(key, { nextOffset, updatedAt }) {
      if (!Number.isInteger(nextOffset) || nextOffset < 0) {
        throw new StorageError("nextOffset must be a non-negative integer", {
          code: "STORE_CONFIG_INVALID"
        });
      }
      const value = {
        key,
        nextOffset,
        updatedAt: typeof updatedAt === "string" ? updatedAt : new Date().toISOString()
      };
      await writeJsonObject(pathForKey(key), value);
      return value;
    },

    async reset(key) {
      return await this.set(key, { nextOffset: 0, updatedAt: new Date().toISOString() });
    }
  };
}
