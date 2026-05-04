// Generic JSONL append-and-read primitives.
//
// Why JSONL: append-only logs (articles, attempts, LLM raw responses) are
// safer than rewriting one fat array — partial writes corrupt only the last
// line, and tail growth is O(record) not O(file).
//
// On corruption we DO NOT silently skip bad lines. Step 1 acceptance:
// "JSON / JSONL 损坏时不会静默失败,返回明确错误." Bad lines surface as a
// StorageError with the line number so the user can locate and fix the file.

import { mkdir, readFile, appendFile, access } from "node:fs/promises";
import { dirname } from "node:path";
import { StorageError } from "../domain/errors.js";

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

/**
 * Append one JSON-serializable record as a single line to the JSONL file.
 * Creates parent directories on demand. Records are stringified without
 * pretty-printing so each line stays parseable.
 */
export async function appendJsonlRecord(filePath, record) {
  await ensureParentDir(filePath);
  const line = JSON.stringify(record);
  if (line.includes("\n")) {
    // JSON.stringify cannot produce a literal newline outside strings, but
    // a string field could contain one. Reject so the file stays line-safe.
    throw new StorageError("JSONL record serialized to a value containing a newline", {
      code: "JSONL_RECORD_HAS_NEWLINE",
      path: filePath
    });
  }
  try {
    await appendFile(filePath, line + "\n", "utf8");
  } catch (cause) {
    throw new StorageError("failed to append JSONL record", {
      code: "JSONL_APPEND_FAILED",
      cause,
      path: filePath
    });
  }
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
 * Read all records from the JSONL file. Returns [] when the file does not
 * exist or is empty. Throws StorageError with line number when any line
 * contains malformed JSON — this is the visible-failure contract.
 */
export async function readJsonlRecords(filePath) {
  if (!(await fileExists(filePath))) {
    return [];
  }

  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    throw new StorageError("failed to read JSONL file", {
      code: "JSONL_READ_FAILED",
      cause,
      path: filePath
    });
  }

  if (raw.length === 0) {
    return [];
  }

  const lines = raw.split(/\r?\n/);
  const records = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) {
      // Trailing newline produces a final empty segment — skip it.
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch (cause) {
      throw new StorageError(
        `JSONL line ${i + 1} is not valid JSON`,
        { code: "JSONL_LINE_CORRUPT", cause, path: filePath }
      );
    }
  }

  return records;
}
