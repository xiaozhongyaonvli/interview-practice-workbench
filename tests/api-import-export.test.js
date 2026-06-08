import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";
import { BACKUP_SCHEMA, BACKUP_VERSION } from "../src/domain/backup.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-import-export-"));
}

function questionRecord(id, overrides = {}) {
  const now = "2026-06-08T00:00:00.000Z";
  return {
    id,
    question: "How do you troubleshoot slow SQL?",
    category: "MySQL",
    tags: ["MySQL"],
    difficulty: "medium",
    confidence: 1,
    status: "candidate",
    query: "mysql",
    source: "manual",
    evidence: "manual",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function cardRecord(id, overrides = {}) {
  const today = "2026-06-08";
  return {
    id,
    title: "How do you troubleshoot slow SQL?",
    count: 0,
    category: "MySQL",
    tags: ["MySQL"],
    difficulty: "medium",
    createdAt: today,
    updatedAt: today,
    question: "How do you troubleshoot slow SQL?",
    myAnswer: "Check slow logs, EXPLAIN, indexes, and workload shape.",
    feedbackPromptVersion: "interview-coach-v2",
    feedback: {
      performanceScore: {
        scores: {
          technicalCorrectness: 8,
          coverageCompleteness: 8,
          logicalStructure: 8,
          expressionClarity: 8,
          interviewPerformance: 8
        },
        overallComment: "Solid answer."
      }
    },
    ...overrides
  };
}

function bundle(sections) {
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: "2026-06-08T00:00:00.000Z",
    sections
  };
}

async function applyBundle(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/import/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response;
}

test("GET /api/export?scope=questions exports only the question pool", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      await applyBundle(baseUrl, {
        bundle: bundle({ questions: { items: [questionRecord("q-export")] } }),
        mode: { questions: "replace" }
      });

      const response = await fetch(`${baseUrl}/api/export?scope=questions`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-disposition") ?? "", /interview-workbench-backup-/);
      const exported = await response.json();
      assert.equal(exported.schema, BACKUP_SCHEMA);
      assert.equal(exported.version, BACKUP_VERSION);
      assert.equal(exported.sections.questions.items.length, 1);
      assert.equal(exported.sections.questions.items[0].id, "q-export");
      assert.equal(exported.sections.cards, undefined);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/export rejects unknown scopes", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/export?scope=attempts`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "EXPORT_SCOPE_INVALID");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/import/preview detects sections and invalid records without writing", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/import/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundle: bundle({
            questions: {
              items: [
                questionRecord("q-ok"),
                questionRecord("q-bad", { category: "Frontend" })
              ]
            },
            cards: { items: [cardRecord("card-ok")] }
          })
        })
      });
      assert.equal(response.status, 200);
      const preview = await response.json();
      assert.deepEqual(preview.detected, { questions: true, cards: true });
      assert.equal(preview.validation.questions.valid, 1);
      assert.equal(preview.validation.questions.invalid, 1);
      assert.equal(preview.validation.cards.valid, 1);

      const list = await (await fetch(`${baseUrl}/api/questions?includeIgnored=1`)).json();
      assert.equal(list.questions.length, 0);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/import/apply replace overwrites the question pool", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      await applyBundle(baseUrl, {
        bundle: bundle({ questions: { items: [questionRecord("q-old")] } }),
        mode: { questions: "replace" }
      });

      const response = await applyBundle(baseUrl, {
        bundle: bundle({ questions: { items: [questionRecord("q-new")] } }),
        mode: { questions: "replace" }
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.questions.before, 1);
      assert.equal(result.questions.after, 1);
      assert.equal(result.questions.replaced, 1);

      const list = await (await fetch(`${baseUrl}/api/questions?includeIgnored=1`)).json();
      assert.deepEqual(list.questions.map((q) => q.id), ["q-new"]);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/import/apply append deduplicates questions by semantic key and prefers incoming", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      await applyBundle(baseUrl, {
        bundle: bundle({ questions: { items: [questionRecord("q-old", { evidence: "old" })] } }),
        mode: { questions: "replace" }
      });

      const incomingReplacement = questionRecord("q-new-id", {
        evidence: "new",
        updatedAt: "2026-06-09T00:00:00.000Z"
      });
      const incomingUnique = questionRecord("q-unique", {
        question: "How does InnoDB guarantee ACID?"
      });
      const response = await applyBundle(baseUrl, {
        bundle: bundle({ questions: { items: [incomingReplacement, incomingUnique] } }),
        mode: { questions: "append" }
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.questions.after, 2);
      assert.equal(result.questions.added, 1);
      assert.equal(result.questions.replaced, 1);
      assert.equal(result.questions.duplicates, 1);

      const list = await (await fetch(`${baseUrl}/api/questions?includeIgnored=1`)).json();
      assert.equal(list.questions.find((q) => q.id === "q-old"), undefined);
      assert.equal(list.questions.find((q) => q.id === "q-new-id").evidence, "new");
      assert.ok(list.questions.find((q) => q.id === "q-unique"));
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/import/apply replace cards rebuilds index and removes stale card files", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      await applyBundle(baseUrl, {
        bundle: bundle({ cards: { items: [cardRecord("card-old")] } }),
        mode: { cards: "replace" }
      });
      await access(join(baseDir, "cards", "card-old.json"));

      const response = await applyBundle(baseUrl, {
        bundle: bundle({ cards: { items: [cardRecord("card-new")] } }),
        mode: { cards: "replace" }
      });
      assert.equal(response.status, 200);

      const index = JSON.parse(await readFile(join(baseDir, "cards", "index.json"), "utf8"));
      assert.deepEqual(index, ["card-new.json"]);
      await assert.rejects(
        () => access(join(baseDir, "cards", "card-old.json")),
        /ENOENT/
      );
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/import/apply append cards deduplicates and puts imported cards first", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      await applyBundle(baseUrl, {
        bundle: bundle({
          cards: {
            items: [
              cardRecord("card-a", { myAnswer: "old answer" }),
              cardRecord("card-b", { question: "Existing card B", myAnswer: "old b" })
            ]
          }
        }),
        mode: { cards: "replace" }
      });

      const response = await applyBundle(baseUrl, {
        bundle: bundle({
          cards: {
            items: [
              cardRecord("card-a", { myAnswer: "imported answer" }),
              cardRecord("card-c", { question: "Imported card C", myAnswer: "new c" })
            ]
          }
        }),
        mode: { cards: "append" }
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.cards.after, 3);
      assert.equal(result.cards.added, 1);
      assert.equal(result.cards.replaced, 1);

      const cards = await (await fetch(`${baseUrl}/api/cards`)).json();
      assert.deepEqual(cards.cards.map((card) => card.id), ["card-a", "card-c", "card-b"]);
      assert.equal(cards.cards[0].myAnswer, "imported answer");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/import/apply skip leaves a detected section unchanged", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      await applyBundle(baseUrl, {
        bundle: bundle({ questions: { items: [questionRecord("q-original")] } }),
        mode: { questions: "replace" }
      });

      const response = await applyBundle(baseUrl, {
        bundle: bundle({ questions: { items: [questionRecord("q-incoming")] } }),
        mode: { questions: "skip" }
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.questions.mode, "skip");
      assert.equal(result.questions.after, 1);

      const list = await (await fetch(`${baseUrl}/api/questions?includeIgnored=1`)).json();
      assert.deepEqual(list.questions.map((q) => q.id), ["q-original"]);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
