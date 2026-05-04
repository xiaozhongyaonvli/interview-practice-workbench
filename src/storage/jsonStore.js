// Generic JSON object read/write primitives for state files (question pool,
// card index, etc.) where the file holds a single mutable structure.
//
// Writes are atomic-ish: write to a sibling .tmp file then rename. If the
// process crashes mid-write the original file remains intact.

import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { dirname } from "node:path";
import { StorageError } from "../domain/errors.js";

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a JSON file. Returns the provided defaultValue (default: null) when
 * the file does not exist or is empty. Throws StorageError on malformed
 * JSON — visible failure, not silent fallback.
 */
export async function readJsonObject(filePath, { defaultValue = null } = {}) {
  if (!(await fileExists(filePath))) {
    return defaultValue;
  }

  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    throw new StorageError("failed to read JSON file", {
      code: "JSON_READ_FAILED",
      cause,
      path: filePath
    });
  }

  if (raw.trim().length === 0) {
    return defaultValue;
  }

  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new StorageError("file is not valid JSON", {
      code: "JSON_FILE_CORRUPT",
      cause,
      path: filePath
    });
  }
}

/**
 * Write a JSON object atomically. Writes to <path>.tmp then rename().
 * Pretty-prints with two-space indent so the file diffs cleanly under git.
 */
export async function writeJsonObject(filePath, value) {
  await ensureParentDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  const body = JSON.stringify(value, null, 2);
  try {
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, filePath);
  } catch (cause) {
    throw new StorageError("failed to write JSON file", {
      code: "JSON_WRITE_FAILED",
      cause,
      path: filePath
    });
  }
}
