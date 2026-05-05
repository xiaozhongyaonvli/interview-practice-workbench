// LlmEvaluationService — domain-facing LLM operations.
//
// Two methods:
//   extractQuestions({ query, title, text })
//       -> { extraction, raw } where extraction is parsed-and-validated
//   scoreAnswer({ question, answer, context })
//       -> { summary, raw }
//
// The service:
//   - asks PromptProvider for the prompt body
//   - calls a `chatComplete(prompt) -> string` function (injected so tests
//     never hit the real model)
//   - tries to extract a JSON payload from the model's reply (tolerates
//     ```json``` fences, leading/trailing prose)
//   - validates against the corresponding schema
//   - on any failure, persists raw + error to llmDebugStore so the user can
//     inspect what the model produced (CEO red-line: never silently lose)
//
// The result is the API layer can call this service without thinking about
// HTTP, parsing, or fence stripping.

import { ValidationError } from "../domain/errors.js";
import { validateExtractionResult } from "../domain/extraction.js";
import { validateScoreSummary } from "../domain/scoreSummary.js";

function tryExtractJson(raw) {
  if (typeof raw !== "string") return null;
  // 1) Direct parse first.
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  // 2) Strip leading/trailing whitespace + ```json``` fence.
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  // 3) Look for the first balanced { ... } block.
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

export function createLlmEvaluationService({
  chatComplete,
  promptProvider,
  llmDebugStore
}) {
  if (typeof chatComplete !== "function") {
    throw new Error("createLlmEvaluationService: chatComplete is required");
  }
  if (!promptProvider) {
    throw new Error("createLlmEvaluationService: promptProvider is required");
  }
  if (!llmDebugStore) {
    throw new Error("createLlmEvaluationService: llmDebugStore is required");
  }

  async function extractQuestions({ query, title, text }) {
    const prompt = await promptProvider.extractionPrompt({ query, title, text });
    let raw;
    try {
      raw = await chatComplete(prompt, { phase: "extraction" });
    } catch (err) {
      await llmDebugStore.appendRaw({
        phase: "extraction",
        requestMeta: { query, title },
        rawResponse: "",
        error: { code: "LLM_CALL_FAILED", message: err?.message ?? String(err) }
      });
      throw new ValidationError("LLM call failed", {
        code: "LLM_CALL_FAILED",
        path: "chatComplete"
      });
    }
    const parsed = tryExtractJson(raw);
    if (!parsed) {
      await llmDebugStore.appendRaw({
        phase: "extraction",
        requestMeta: { query, title },
        rawResponse: raw,
        error: { code: "EXTRACTION_NOT_JSON" }
      });
      throw new ValidationError("LLM extraction response is not valid JSON", {
        code: "EXTRACTION_NOT_JSON",
        path: "rawResponse"
      });
    }
    try {
      validateExtractionResult(parsed);
    } catch (err) {
      await llmDebugStore.appendRaw({
        phase: "extraction",
        requestMeta: { query, title },
        rawResponse: raw,
        parsed,
        error: err
      });
      throw err;
    }
    return { extraction: parsed, raw };
  }

  async function scoreAnswer({ question, answer, context = "" }) {
    const prompt = await promptProvider.scoringPrompt({ question, answer, context });
    let raw;
    try {
      raw = await chatComplete(prompt, { phase: "scoring" });
    } catch (err) {
      await llmDebugStore.appendRaw({
        phase: "scoring",
        requestMeta: { question },
        rawResponse: "",
        error: { code: "LLM_CALL_FAILED", message: err?.message ?? String(err) }
      });
      throw new ValidationError("LLM call failed", {
        code: "LLM_CALL_FAILED",
        path: "chatComplete"
      });
    }
    const parsed = tryExtractJson(raw);
    if (!parsed) {
      await llmDebugStore.appendRaw({
        phase: "scoring",
        requestMeta: { question },
        rawResponse: raw,
        error: { code: "SCORING_NOT_JSON" }
      });
      throw new ValidationError("LLM scoring response is not valid JSON", {
        code: "SCORING_NOT_JSON",
        path: "rawResponse"
      });
    }
    // The scoring prompt asks for a flat ScoreSummary shape.
    try {
      validateScoreSummary(parsed);
    } catch (err) {
      await llmDebugStore.appendRaw({
        phase: "scoring",
        requestMeta: { question },
        rawResponse: raw,
        parsed,
        error: err
      });
      throw err;
    }
    return { summary: parsed, raw };
  }

  // Batch-classify a list of titles. Output schema (the prompt asks for it):
  //   [{"index": 0, "isInterview": true|false}, ...]
  // We do not let this gate block production of questions. If the model omits
  // some rows, omitted titles default to true (let extraction decide). If the
  // model returns an out-of-range index, we log it and ignore that row.
  // Only non-JSON output still throws so the adapter can use its fallback.
  async function classifyInterviewTitles({ titles }) {
    if (!Array.isArray(titles) || titles.length === 0) {
      return { flags: [], raw: "" };
    }
    const prompt = await promptProvider.interviewClassifyPrompt({ titles });
    let raw;
    try {
      raw = await chatComplete(prompt, { phase: "classify" });
    } catch (err) {
      await llmDebugStore.appendRaw({
        phase: "classify",
        requestMeta: { count: titles.length, titles },
        rawResponse: "",
        error: { code: "LLM_CALL_FAILED", message: err?.message ?? String(err) }
      });
      throw new ValidationError("LLM call failed", {
        code: "LLM_CALL_FAILED",
        path: "chatComplete"
      });
    }
    const parsed = tryExtractJsonArray(raw);
    if (!parsed) {
      await llmDebugStore.appendRaw({
        phase: "classify",
        requestMeta: { count: titles.length, titles },
        rawResponse: raw,
        error: { code: "CLASSIFY_NOT_JSON" }
      });
      throw new ValidationError("classify response is not valid JSON array", {
        code: "CLASSIFY_NOT_JSON",
        path: "rawResponse"
      });
    }
    const flags = new Array(titles.length).fill(true);
    if (parsed.length !== titles.length) {
      await llmDebugStore.appendRaw({
        phase: "classify",
        requestMeta: { count: titles.length, got: parsed.length, titles },
        rawResponse: raw,
        parsed,
        error: {
          code: "CLASSIFY_LENGTH_MISMATCH",
          message: `classify returned ${parsed.length} items, expected ${titles.length}; missing rows defaulted to true`
        }
      });
    }
    for (let i = 0; i < parsed.length; i += 1) {
      const item = parsed[i];
      const idx = typeof item?.index === "number" ? item.index : i;
      if (idx < 0 || idx >= titles.length) {
        await llmDebugStore.appendRaw({
          phase: "classify",
          requestMeta: { count: titles.length, titles },
          rawResponse: raw,
          parsed,
          error: {
            code: "CLASSIFY_INDEX_OUT_OF_RANGE",
            message: `ignored out-of-range classify index ${idx}`,
            value: idx
          }
        });
        continue;
      }
      flags[idx] = item?.isInterview === true;
    }
    return { flags, raw };
  }

  return { extractQuestions, scoreAnswer, classifyInterviewTitles };
}

// Try parsing `raw` (string) as a top-level JSON array. Tolerates
// ```json``` fences and leading prose, mirroring tryExtractJson but for [...]
// shape. Returns the array or null.
function tryExtractJsonArray(raw) {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const v = JSON.parse(fenced[1]);
      if (Array.isArray(v)) return v;
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("[");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try {
            const v = JSON.parse(candidate);
            if (Array.isArray(v)) return v;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

// Internal helper exposed for tests so they can verify fence/JSON extraction
// without going through the full service.
export const _internals = { tryExtractJson, tryExtractJsonArray };
