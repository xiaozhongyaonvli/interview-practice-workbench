import {
  assertNoInvalid,
  createBackupBundle,
  dedupeCards,
  dedupeQuestions,
  mergeCards,
  mergeQuestions,
  normalizeImportMode,
  parseBackupBundle
} from "../domain/backup.js";
import { ValidationError } from "../domain/errors.js";
import { readJsonBody, sendJson, sendError } from "./http.js";

const EXPORT_SCOPES = new Set(["all", "questions", "cards"]);

function backupFilename(now) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-");
  return `interview-workbench-backup-${stamp}.json`;
}

function requireBundle(body) {
  if (body.bundle === undefined) {
    throw new ValidationError("bundle is required", {
      code: "BACKUP_INPUT_INVALID",
      path: "bundle"
    });
  }
  return body.bundle;
}

function previewSection(section, localCount) {
  return {
    included: section.included,
    incoming: section.items.length,
    valid: section.valid.length,
    invalid: section.invalid.length,
    errors: section.invalid,
    requiresDecision: section.included && localCount > 0
  };
}

function emptyResult(mode, before) {
  return {
    mode,
    before,
    incoming: 0,
    after: before,
    added: 0,
    replaced: 0,
    duplicates: 0,
    invalid: 0
  };
}

export function createImportExportApi({ questionStore, cardStore, now = () => new Date() }) {
  if (!questionStore) throw new Error("createImportExportApi: questionStore required");
  if (!cardStore) throw new Error("createImportExportApi: cardStore required");

  async function listCards() {
    if (typeof cardStore.list === "function") return await cardStore.list();
    const index = await cardStore.listIndex();
    const cards = [];
    for (const filename of index) {
      const card = await cardStore.getById(String(filename).replace(/\.json$/, ""));
      if (card) cards.push(card);
    }
    return cards;
  }

  async function handleExport(req, res, url) {
    try {
      const scope = url.searchParams.get("scope") || "all";
      if (!EXPORT_SCOPES.has(scope)) {
        throw new ValidationError("scope must be all, questions, or cards", {
          code: "EXPORT_SCOPE_INVALID",
          path: "scope"
        });
      }

      const includeQuestions = scope === "all" || scope === "questions";
      const includeCards = scope === "all" || scope === "cards";
      const questions = includeQuestions ? await questionStore.list() : null;
      const cards = includeCards ? await listCards() : null;
      const timestamp = now();
      const bundle = createBackupBundle({ questions, cards, now: timestamp });
      const body = JSON.stringify(bundle, null, 2);

      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${backupFilename(timestamp)}"`
      });
      res.end(body);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePreview(req, res) {
    try {
      const body = await readJsonBody(req);
      const parsed = parseBackupBundle(requireBundle(body));
      const [questions, cards] = await Promise.all([
        questionStore.list(),
        listCards()
      ]);
      sendJson(res, 200, {
        detected: {
          questions: parsed.questions.included,
          cards: parsed.cards.included
        },
        local: {
          questions: questions.length,
          cards: cards.length
        },
        incoming: {
          questions: parsed.questions.items.length,
          cards: parsed.cards.items.length
        },
        requiresDecision: {
          questions: parsed.questions.included && questions.length > 0,
          cards: parsed.cards.included && cards.length > 0
        },
        validation: {
          questions: previewSection(parsed.questions, questions.length),
          cards: previewSection(parsed.cards, cards.length)
        }
      });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleApply(req, res) {
    try {
      const body = await readJsonBody(req);
      const parsed = parseBackupBundle(requireBundle(body));
      assertNoInvalid(parsed);

      const modeInput = body.mode && typeof body.mode === "object" ? body.mode : {};
      const [existingQuestions, existingCards] = await Promise.all([
        questionStore.list(),
        listCards()
      ]);

      const result = {};

      if (parsed.questions.included) {
        const mode = modeInput.questions === undefined && existingQuestions.length === 0
          ? "append"
          : normalizeImportMode(modeInput.questions, "mode.questions");
        result.questions = await applyQuestions(mode, existingQuestions, parsed.questions.valid);
      } else {
        result.questions = emptyResult("not_included", existingQuestions.length);
      }

      if (parsed.cards.included) {
        const mode = modeInput.cards === undefined && existingCards.length === 0
          ? "append"
          : normalizeImportMode(modeInput.cards, "mode.cards");
        result.cards = await applyCards(mode, existingCards, parsed.cards.valid);
      } else {
        result.cards = emptyResult("not_included", existingCards.length);
      }

      sendJson(res, 200, result);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function applyQuestions(mode, existing, incoming) {
    if (mode === "skip") return emptyResult("skip", existing.length);
    if (mode === "replace") {
      const deduped = dedupeQuestions(incoming);
      await questionStore.replaceAll(deduped.records);
      return {
        mode,
        before: existing.length,
        incoming: incoming.length,
        after: deduped.records.length,
        added: deduped.records.length,
        replaced: existing.length,
        duplicates: deduped.duplicates,
        invalid: 0
      };
    }

    const merged = mergeQuestions(existing, incoming);
    await questionStore.replaceAll(merged.records);
    return {
      mode,
      before: existing.length,
      incoming: incoming.length,
      after: merged.records.length,
      added: merged.added,
      replaced: merged.replaced,
      duplicates: merged.duplicates,
      invalid: 0
    };
  }

  async function applyCards(mode, existing, incoming) {
    if (mode === "skip") return emptyResult("skip", existing.length);
    if (mode === "replace") {
      const deduped = dedupeCards(incoming);
      await cardStore.replaceAll(deduped.records);
      return {
        mode,
        before: existing.length,
        incoming: incoming.length,
        after: deduped.records.length,
        added: deduped.records.length,
        replaced: existing.length,
        duplicates: deduped.duplicates,
        invalid: 0
      };
    }

    const merged = mergeCards(existing, incoming);
    await cardStore.replaceAll(merged.records);
    return {
      mode,
      before: existing.length,
      incoming: incoming.length,
      after: merged.records.length,
      added: merged.added,
      replaced: merged.replaced,
      duplicates: merged.duplicates,
      invalid: 0
    };
  }

  return { handleExport, handlePreview, handleApply };
}
