// Question API — POST import (LLM JSON paste), GET list, PATCH status.
//
// Step 3 explicitly does not call a real LLM — the user pastes the
// extraction JSON. We still treat the payload as untrusted: parse + schema
// validate, log raw on failure, never half-write the pool.

import { ValidationError } from "../domain/errors.js";
import {
  validateExtractionResult,
  extractionItemToQuestionRecord
} from "../domain/extraction.js";
import { QUESTION_STATUSES } from "../domain/question.js";
import { ALLOWED_CATEGORIES } from "../domain/categories.js";
import { readJsonBody, sendJson, sendError } from "./http.js";

// SAFE_QUERY accepts Unicode letters/digits (so 面经 / 计网 / mysql all pass)
// while still rejecting path separators, shell metachars, and whitespace.
const SAFE_QUERY = /^[\p{L}\p{N}_-]{1,64}$/u;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function requireString(value, field, code = "QUESTION_INPUT_INVALID") {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`, {
      code,
      path: field
    });
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function createQuestionApi({ questionStore, llmDebugStore, articleStore = null, llmService = null, now = nowIso }) {
  if (!questionStore) throw new Error("createQuestionApi: questionStore is required");
  if (!llmDebugStore) throw new Error("createQuestionApi: llmDebugStore is required");

  async function handleImport(req, res) {
    try {
      const body = await readJsonBody(req);

      requireString(body.query, "query");
      if (!SAFE_QUERY.test(body.query)) {
        throw new ValidationError("query must contain only A-Za-z0-9_-", {
          code: "QUESTION_INPUT_INVALID",
          path: "query"
        });
      }

      // Provenance fields are required so each extracted question can be traced.
      requireString(body.source, "source");
      if (
        body.sourceArticleId !== undefined &&
        body.sourceArticleId !== null &&
        typeof body.sourceArticleId !== "string"
      ) {
        throw new ValidationError("sourceArticleId must be a string when present", {
          code: "QUESTION_INPUT_INVALID",
          path: "sourceArticleId"
        });
      }

      // Caller can hand us either an already-parsed object (extraction) OR
      // a raw string the LLM produced (rawResponse). The raw path lets us
      // capture malformed JSON BEFORE we throw, satisfying the "保存原始
      // 响应用于调试" acceptance.
      let parsed = body.extraction ?? null;
      const rawResponse = typeof body.rawResponse === "string" ? body.rawResponse : null;

      if (parsed === null && rawResponse !== null) {
        try {
          parsed = JSON.parse(rawResponse);
        } catch (parseErr) {
          await llmDebugStore.appendRaw({
            phase: "extraction",
            requestMeta: {
              query: body.query,
              sourceArticleId: body.sourceArticleId ?? null,
              source: body.source
            },
            rawResponse,
            error: { code: "EXTRACTION_NOT_JSON", message: parseErr.message }
          });
          throw new ValidationError("rawResponse is not valid JSON", {
            code: "EXTRACTION_NOT_JSON",
            path: "rawResponse"
          });
        }
      }

      if (parsed === null) {
        throw new ValidationError(
          "body must contain either extraction or rawResponse",
          { code: "QUESTION_INPUT_INVALID", path: "extraction" }
        );
      }

      // Schema validate. On failure, persist the raw and the validation error
      // so the user can correct and re-paste.
      try {
        validateExtractionResult(parsed);
      } catch (err) {
        await llmDebugStore.appendRaw({
          phase: "extraction",
          requestMeta: {
            query: body.query,
            sourceArticleId: body.sourceArticleId ?? null,
            source: body.source
          },
          rawResponse: rawResponse ?? JSON.stringify(parsed),
          parsed,
          error: err
        });
        throw err;
      }

      // Convert each extraction item into a full QuestionRecord, then insert
      // into the store one by one so we can report duplicates and per-item
      // errors instead of failing the whole import.
      const provenance = {
        query: body.query,
        source: body.source,
        sourceUrl: body.sourceUrl ?? null,
        sourceTitle: body.sourceTitle ?? null
      };
      const ts = now();

      const added = [];
      const duplicates = [];
      const errors = [];

      for (let i = 0; i < parsed.questions.length; i += 1) {
        const item = parsed.questions[i];
        let record;
        try {
          record = extractionItemToQuestionRecord(item, provenance, { now: ts });
        } catch (err) {
          errors.push({
            index: i,
            error: err.message ?? String(err),
            code: err.code ?? null
          });
          continue;
        }
        try {
          await questionStore.add(record);
          added.push(record);
        } catch (err) {
          if (err?.code === "QUESTION_DUPLICATE_ID") {
            duplicates.push({ index: i, id: record.id });
          } else {
            errors.push({
              index: i,
              error: err.message ?? String(err),
              code: err.code ?? null
            });
          }
        }
      }

      // Even when every item failed, we return 200 with the breakdown so the
      // user can see what happened. Outright invalid bodies were already
      // handled above with a 4xx.
      sendJson(res, 200, { added, duplicates, errors });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleList(req, res, url) {
    try {
      const all = await questionStore.list();
      const query = url.searchParams.get("query");
      const category = url.searchParams.get("category");
      const status = url.searchParams.get("status");

      const filtered = all.filter((q) => {
        if (query && q.query !== query) return false;
        if (category && q.category !== category) return false;
        if (status && q.status !== status) return false;
        return true;
      });

      sendJson(res, 200, {
        questions: filtered,
        meta: {
          total: all.length,
          filtered: filtered.length,
          categories: ALLOWED_CATEGORIES,
          statuses: QUESTION_STATUSES
        }
      });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleUpdate(req, res, id) {
    try {
      if (!SAFE_ID.test(id)) {
        throw new ValidationError("id must contain only A-Za-z0-9_-", {
          code: "QUESTION_INPUT_INVALID",
          path: "id"
        });
      }
      const body = await readJsonBody(req);
      const patch = {};
      if (body.status !== undefined) {
        if (!QUESTION_STATUSES.includes(body.status)) {
          throw new ValidationError(
            `status must be one of ${QUESTION_STATUSES.join(", ")}`,
            { code: "QUESTION_INPUT_INVALID", path: "status" }
          );
        }
        patch.status = body.status;
      }
      if (body.category !== undefined) {
        // category change is a corrective action when the LLM picked the
        // wrong category. Validation runs inside the store via
        // validateQuestionRecord on the merged record.
        patch.category = body.category;
      }
      patch.updatedAt = now();
      const updated = await questionStore.update(id, patch);
      sendJson(res, 200, updated);
    } catch (err) {
      sendError(res, err);
    }
  }

  return { handleImport, handleList, handleUpdate, handleExtract };

  /**
   * POST /api/questions/extract — call the real LLM to extract questions
   * from a saved article. The article is identified by either:
   *   - articleId: lookup in articleStore
   *   - or pasted-shape body { query, title, text } for ad-hoc usage
   *
   * Successful extractions are persisted into the question pool the same
   * way as /import, so this route is just /import with an LLM front end.
   */
  async function handleExtract(req, res) {
    try {
      if (!llmService || !articleStore) {
        throw new ValidationError(
          "LLM extraction is not configured (set DEEPSEEK_API_KEY)",
          { code: "LLM_NOT_CONFIGURED", path: "service" }
        );
      }
      const body = await readJsonBody(req);
      requireString(body.query, "query");
      if (!SAFE_QUERY.test(body.query)) {
        throw new ValidationError("query must contain only A-Za-z0-9_-", {
          code: "QUESTION_INPUT_INVALID",
          path: "query"
        });
      }

      let title;
      let text;
      let sourceUrl = null;
      let source = "manual";
      if (typeof body.articleId === "string" && body.articleId.length > 0) {
        const articles = await articleStore.listByQuery(body.query);
        const article = articles.find((a) => a.id === body.articleId);
        if (!article) {
          throw new ValidationError(`article "${body.articleId}" not found for query "${body.query}"`, {
            code: "ARTICLE_NOT_FOUND",
            path: "articleId"
          });
        }
        title = article.title;
        text = article.text;
        sourceUrl = article.sourceUrl ?? null;
        source = article.source;
      } else {
        requireString(body.title, "title");
        requireString(body.text, "text");
        title = body.title;
        text = body.text;
      }

      const { extraction } = await llmService.extractQuestions({
        query: body.query,
        title,
        text
      });

      const provenance = {
        query: body.query,
        source,
        sourceUrl,
        sourceTitle: title
      };
      const ts = now();
      const added = [];
      const duplicates = [];
      const errors = [];

      for (let i = 0; i < extraction.questions.length; i += 1) {
        const item = extraction.questions[i];
        let record;
        try {
          record = extractionItemToQuestionRecord(item, provenance, { now: ts });
        } catch (err) {
          errors.push({ index: i, error: err.message ?? String(err), code: err.code ?? null });
          continue;
        }
        try {
          await questionStore.add(record);
          added.push(record);
        } catch (err) {
          if (err?.code === "QUESTION_DUPLICATE_ID") {
            duplicates.push({ index: i, id: record.id });
          } else {
            errors.push({ index: i, error: err.message ?? String(err), code: err.code ?? null });
          }
        }
      }

      sendJson(res, 200, { added, duplicates, errors });
    } catch (err) {
      sendError(res, err);
    }
  }
}
