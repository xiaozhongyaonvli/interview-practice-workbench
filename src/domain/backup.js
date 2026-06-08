import { ValidationError } from "./errors.js";
import { validateQuestionRecord } from "./question.js";
import { validateCardRecord } from "./card.js";

export const BACKUP_SCHEMA = "interview-training-workbench.backup";
export const BACKUP_VERSION = 1;
export const IMPORT_MODES = Object.freeze(["append", "replace", "skip"]);

function fail(message, path, code = "BACKUP_INVALID") {
  throw new ValidationError(message, { code, path });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function questionSemanticKey(question) {
  return [
    normalizeText(question?.question),
    normalizeText(question?.category),
    normalizeText(question?.query)
  ].join("|");
}

export function cardSemanticKey(card) {
  return [
    normalizeText(card?.question),
    normalizeText(card?.myAnswer)
  ].join("|");
}

function validateSection(section, path) {
  if (section === undefined) return null;
  if (!isPlainObject(section)) {
    fail(`${path} must be an object`, path);
  }
  if (!Array.isArray(section.items)) {
    fail(`${path}.items must be an array`, `${path}.items`);
  }
  return section.items;
}

function validateRecords(items, kind) {
  const valid = [];
  const invalid = [];
  const validator = kind === "questions" ? validateQuestionRecord : validateCardRecord;
  for (let i = 0; i < items.length; i += 1) {
    const record = items[i];
    try {
      validator(record);
      valid.push(record);
    } catch (err) {
      invalid.push({
        index: i,
        code: err?.code ?? null,
        path: err?.path ?? null,
        error: err?.message ?? String(err)
      });
    }
  }
  return { valid, invalid };
}

export function parseBackupBundle(bundle) {
  if (!isPlainObject(bundle)) {
    fail("backup bundle must be a JSON object", "bundle");
  }
  if (bundle.schema !== BACKUP_SCHEMA) {
    fail("unsupported backup schema", "schema", "BACKUP_SCHEMA_UNSUPPORTED");
  }
  if (bundle.version !== BACKUP_VERSION) {
    fail("unsupported backup version", "version", "BACKUP_VERSION_UNSUPPORTED");
  }
  if (!isPlainObject(bundle.sections)) {
    fail("backup sections must be an object", "sections");
  }

  const questionItems = validateSection(bundle.sections.questions, "sections.questions");
  const cardItems = validateSection(bundle.sections.cards, "sections.cards");
  if (questionItems === null && cardItems === null) {
    fail("backup must include questions or cards", "sections");
  }

  const questions = questionItems === null
    ? { included: false, items: [], valid: [], invalid: [] }
    : {
        included: true,
        items: questionItems,
        ...validateRecords(questionItems, "questions")
      };
  const cards = cardItems === null
    ? { included: false, items: [], valid: [], invalid: [] }
    : {
        included: true,
        items: cardItems,
        ...validateRecords(cardItems, "cards")
      };

  return { questions, cards };
}

export function assertNoInvalid(parsed) {
  if (parsed.questions.invalid.length > 0) {
    fail("backup contains invalid questions", "sections.questions.items", "BACKUP_RECORDS_INVALID");
  }
  if (parsed.cards.invalid.length > 0) {
    fail("backup contains invalid cards", "sections.cards.items", "BACKUP_RECORDS_INVALID");
  }
}

export function normalizeImportMode(value, path) {
  if (!IMPORT_MODES.includes(value)) {
    fail(`mode must be one of ${IMPORT_MODES.join(", ")}`, path, "IMPORT_MODE_INVALID");
  }
  return value;
}

export function dedupeQuestions(records) {
  return dedupeByKeys(records, (record) => [record.id, questionSemanticKey(record)]);
}

export function dedupeCards(records) {
  return dedupeByKeys(records, (record) => [record.id, cardSemanticKey(record)]);
}

function dedupeByKeys(records, keyFactory) {
  const result = [];
  const keyToIndex = new Map();
  let duplicates = 0;

  for (const record of records) {
    const keys = keyFactory(record).filter((key) => typeof key === "string" && key.length > 0);
    const existingIndex = keys
      .map((key) => keyToIndex.get(key))
      .find((index) => index !== undefined);

    if (existingIndex !== undefined) {
      duplicates += 1;
      result[existingIndex] = record;
      for (const key of keys) keyToIndex.set(key, existingIndex);
      continue;
    }

    const index = result.length;
    result.push(record);
    for (const key of keys) keyToIndex.set(key, index);
  }

  return { records: result, duplicates };
}

export function mergeQuestions(existing, incoming) {
  const deduped = dedupeQuestions(incoming);
  const result = [...existing];
  const idToIndex = new Map();
  const semanticToIndex = new Map();

  for (let i = 0; i < result.length; i += 1) {
    idToIndex.set(result[i].id, i);
    semanticToIndex.set(questionSemanticKey(result[i]), i);
  }

  let added = 0;
  let replaced = 0;
  for (const record of deduped.records) {
    const index = idToIndex.get(record.id) ?? semanticToIndex.get(questionSemanticKey(record));
    if (index === undefined) {
      result.push(record);
      const newIndex = result.length - 1;
      idToIndex.set(record.id, newIndex);
      semanticToIndex.set(questionSemanticKey(record), newIndex);
      added += 1;
    } else {
      result[index] = record;
      idToIndex.set(record.id, index);
      semanticToIndex.set(questionSemanticKey(record), index);
      replaced += 1;
    }
  }

  return {
    records: result,
    added,
    replaced,
    duplicates: deduped.duplicates + replaced
  };
}

export function mergeCards(existing, incoming) {
  const deduped = dedupeCards(incoming);
  const existingMatchIndexes = new Set();
  const idToIndex = new Map();
  const semanticToIndex = new Map();

  for (let i = 0; i < existing.length; i += 1) {
    idToIndex.set(existing[i].id, i);
    semanticToIndex.set(cardSemanticKey(existing[i]), i);
  }

  let added = 0;
  let replaced = 0;
  for (const record of deduped.records) {
    const index = idToIndex.get(record.id) ?? semanticToIndex.get(cardSemanticKey(record));
    if (index === undefined) {
      added += 1;
    } else {
      existingMatchIndexes.add(index);
      replaced += 1;
    }
  }

  const untouched = existing.filter((_, index) => !existingMatchIndexes.has(index));
  return {
    records: [...deduped.records, ...untouched],
    added,
    replaced,
    duplicates: deduped.duplicates + replaced
  };
}

export function createBackupBundle({ questions = null, cards = null, now = new Date() }) {
  const sections = {};
  if (questions !== null) sections.questions = { items: questions };
  if (cards !== null) sections.cards = { items: cards };
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    sections
  };
}
