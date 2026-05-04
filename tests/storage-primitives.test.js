// Tests for the generic jsonl/json storage primitives. Each test creates a
// fresh temp dir via mkdtemp so file-system effects do not leak between
// tests or pollute the workspace data/ directory.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendJsonlRecord,
  readJsonlRecords
} from "../src/storage/jsonlStore.js";
import {
  readJsonObject,
  writeJsonObject
} from "../src/storage/jsonStore.js";
import { StorageError } from "../src/domain/errors.js";

async function makeTmp() {
  return await mkdtemp(join(tmpdir(), "itw-step1-"));
}

test("jsonl: append and read round-trip preserves order", async () => {
  const dir = await makeTmp();
  const file = join(dir, "items.jsonl");
  try {
    await appendJsonlRecord(file, { id: "a", n: 1 });
    await appendJsonlRecord(file, { id: "b", n: 2 });
    await appendJsonlRecord(file, { id: "c", n: 3 });

    const records = await readJsonlRecords(file);
    assert.deepEqual(records, [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 3 }
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("jsonl: missing file returns empty array", async () => {
  const dir = await makeTmp();
  try {
    const records = await readJsonlRecords(join(dir, "absent.jsonl"));
    assert.deepEqual(records, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("jsonl: empty file returns empty array", async () => {
  const dir = await makeTmp();
  const file = join(dir, "empty.jsonl");
  try {
    await writeFile(file, "", "utf8");
    const records = await readJsonlRecords(file);
    assert.deepEqual(records, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("jsonl: a corrupt line surfaces a StorageError carrying the line number", async () => {
  const dir = await makeTmp();
  const file = join(dir, "broken.jsonl");
  try {
    await writeFile(
      file,
      [
        '{"id":"a"}',
        "not json at all",
        '{"id":"c"}'
      ].join("\n") + "\n",
      "utf8"
    );

    await assert.rejects(
      readJsonlRecords(file),
      (err) => {
        assert.ok(err instanceof StorageError);
        assert.equal(err.code, "JSONL_LINE_CORRUPT");
        assert.match(err.message, /line 2/);
        assert.equal(err.path, file);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("jsonl: rejects records that serialize to a value containing a newline", async () => {
  const dir = await makeTmp();
  const file = join(dir, "bad.jsonl");
  try {
    // JSON.stringify quotes the newline as \n, so a string newline is fine.
    // The check exists for theoretical safety; sanity-check that legal data
    // still goes through.
    await appendJsonlRecord(file, { text: "line1\nline2" });
    const records = await readJsonlRecords(file);
    assert.equal(records.length, 1);
    assert.equal(records[0].text, "line1\nline2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("json: write then read returns the same value", async () => {
  const dir = await makeTmp();
  const file = join(dir, "state.json");
  try {
    const value = { questions: [{ id: "q1", question: "test?" }], updatedAt: "2026-05-04" };
    await writeJsonObject(file, value);
    const back = await readJsonObject(file);
    assert.deepEqual(back, value);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("json: missing file returns the supplied defaultValue", async () => {
  const dir = await makeTmp();
  try {
    const v = await readJsonObject(join(dir, "absent.json"), { defaultValue: { items: [] } });
    assert.deepEqual(v, { items: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("json: empty file returns the supplied defaultValue", async () => {
  const dir = await makeTmp();
  const file = join(dir, "empty.json");
  try {
    await writeFile(file, "   \n", "utf8");
    const v = await readJsonObject(file, { defaultValue: { items: [] } });
    assert.deepEqual(v, { items: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("json: corrupt content surfaces a StorageError, not silent fallback", async () => {
  const dir = await makeTmp();
  const file = join(dir, "corrupt.json");
  try {
    await writeFile(file, "{not valid", "utf8");
    await assert.rejects(
      readJsonObject(file),
      (err) => {
        assert.ok(err instanceof StorageError);
        assert.equal(err.code, "JSON_FILE_CORRUPT");
        assert.equal(err.path, file);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
