// Sources API — POST /api/sources/nowcoder/fetch.
//
// New flow (per docs/phase-a-nowcoder-feed-classify-design.md):
//   1. prune nowcoder ArticleRecord older than TTL_DAYS (default 14).
//   2. resolve effective query: missing/empty -> "" (feed mode).
//   3. compute excludeUrls from articleStore for that query partition.
//   4. delegate to nowCoderAdapter.searchAndFetch with a classifyTitles hook
//      bound to the LLM service. Adapter returns only the candidates that
//      passed title-level "is interview?" classification.
//   5. for each surviving record: append to articleStore, then immediately
//      call llmService.extractQuestions on the article body and persist the
//      resulting QuestionRecords.
//   6. respond with { discovered, classifiedYes, classifiedNo, savedArticles,
//      savedQuestions, skippedUrls, failed, prunedArticles, classifyError }.
//
// LLM service is optional. If absent, classification is skipped (treat all as
// interview) and extraction also skipped — caller can still get article bodies
// to drive a manual paste-JSON flow if they really want.

import { ValidationError } from "../domain/errors.js";
import { extractionItemToQuestionRecord } from "../domain/extraction.js";
import { FEED_QUERY_SENTINEL } from "../sources/nowcoderAdapter.js";
import { readJsonBody, sendJson, sendError } from "./http.js";

// Empty string is allowed (feed mode); otherwise only safe word chars.
const SAFE_QUERY_OR_EMPTY = /^[\p{L}\p{N}_-]{0,64}$/u;

function randomSuffix() {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function generateNowCoderId(query) {
  const slug = query === "" ? "feed" : query;
  return `nowcoder-${slug}-${Date.now().toString(36)}-${randomSuffix()}`;
}

export function createSourcesApi({
  nowCoderAdapter,
  articleStore,
  questionStore = null,
  llmService = null,
  ttlDays = 14,
  now = () => new Date().toISOString()
}) {
  if (!nowCoderAdapter) throw new Error("createSourcesApi: nowCoderAdapter required");
  if (!articleStore) throw new Error("createSourcesApi: articleStore required");

  async function handleNowCoderFetch(req, res) {
    try {
      const body = await readJsonBody(req);

      const rawQuery = body?.query;
      const query =
        typeof rawQuery === "string" ? rawQuery.trim() : rawQuery == null ? "" : "";
      if (!SAFE_QUERY_OR_EMPTY.test(query)) {
        throw new ValidationError(
          "query must be empty OR contain only A-Za-z0-9_-",
          { code: "NOWCODER_INPUT_INVALID", path: "query" }
        );
      }
      const maxArticles = Number.isInteger(body?.maxArticles) ? body.maxArticles : 3;

      // 1. Prune. Failure here must NOT block the fetch — log and continue.
      let prunedArticles = 0;
      try {
        if (typeof articleStore.pruneOlderThan === "function") {
          const r = await articleStore.pruneOlderThan({
            days: ttlDays,
            source: "nowcoder"
          });
          prunedArticles = r?.removedCount ?? 0;
        }
      } catch (pruneErr) {
        // eslint-disable-next-line no-console
        console.warn("nowcoder prune failed (continuing):", pruneErr?.message ?? pruneErr);
      }

      // 2. Compute exclusion set from the matching query partition.
      const partitionQuery = query === "" ? FEED_QUERY_SENTINEL : query;
      let excludeUrls = [];
      try {
        const existing = await articleStore.listByQuery(partitionQuery);
        excludeUrls = existing
          .map((a) => a.sourceUrl)
          .filter((u) => typeof u === "string" && u.length > 0);
      } catch {
        excludeUrls = [];
      }

      // 3. Bind classifier (only when LLM service is available).
      let classifyTitles = null;
      if (llmService && typeof llmService.classifyInterviewTitles === "function") {
        classifyTitles = async (titles) => {
          const out = await llmService.classifyInterviewTitles({ titles });
          return out.flags;
        };
      }

      // 4. Delegate to adapter.
      const result = await nowCoderAdapter.searchAndFetch({
        query,
        maxArticles,
        excludeUrls,
        classifyTitles
      });

      const savedArticles = [];
      const savedQuestions = [];
      const failed = [];
      const diagnostics = {
        llmConfigured: Boolean(llmService && questionStore),
        extractionSkippedReason: null,
        extractionAttempted: 0,
        extractionSucceededArticles: 0,
        extractionNoQuestions: 0,
        extractionFailed: 0,
        questionValidationSkipped: 0,
        questionStoreDuplicates: 0,
        articleTextStats: []
      };

      for (const r of result.records) {
        if (r.__error) {
          failed.push({ url: r.url, code: r.code, message: r.message });
          continue;
        }
        const articleId = generateNowCoderId(query);
        const articleRecord = { id: articleId, ...r };
        try {
          await articleStore.append(articleRecord);
          savedArticles.push(articleRecord);
          const text = String(articleRecord.text ?? "");
          diagnostics.articleTextStats.push({
            url: articleRecord.sourceUrl,
            title: articleRecord.title,
            textLength: text.length,
            questionMarkCount: (text.match(/[?？]/g) ?? []).length
          });
        } catch (storeErr) {
          failed.push({
            url: r.sourceUrl,
            code: storeErr?.code ?? "STORE_FAILED",
            message: storeErr?.message ?? String(storeErr)
          });
          continue;
        }

        // 5. Auto-extract questions from this article (if LLM + store wired).
        if (llmService && questionStore) {
          diagnostics.extractionAttempted += 1;
          try {
            const { extraction } = await llmService.extractQuestions({
              query: query === "" ? "面经" : query,
              title: articleRecord.title,
              text: articleRecord.text
            });
            const extractionQuestions = Array.isArray(extraction.questions)
              ? extraction.questions
              : [];
            if (extractionQuestions.length === 0) {
              diagnostics.extractionNoQuestions += 1;
            } else {
              diagnostics.extractionSucceededArticles += 1;
            }
            const provenance = {
              query: partitionQuery,
              source: "nowcoder",
              sourceUrl: articleRecord.sourceUrl,
              sourceTitle: articleRecord.title
            };
            const ts = now();
            for (const item of extractionQuestions) {
              let record;
              try {
                record = extractionItemToQuestionRecord(item, provenance, { now: ts });
              } catch {
                diagnostics.questionValidationSkipped += 1;
                continue;
              }
              try {
                await questionStore.add(record);
                savedQuestions.push(record);
              } catch (err) {
                if (err?.code !== "QUESTION_DUPLICATE_ID") {
                  failed.push({
                    url: articleRecord.sourceUrl,
                    code: err?.code ?? "QUESTION_STORE_FAILED",
                    message: err?.message ?? String(err)
                  });
                } else {
                  diagnostics.questionStoreDuplicates += 1;
                }
              }
            }
          } catch (extractErr) {
            diagnostics.extractionFailed += 1;
            failed.push({
              url: articleRecord.sourceUrl,
              code: extractErr?.code ?? "EXTRACT_FAILED",
              message: extractErr?.message ?? String(extractErr)
            });
          }
        }
      }
      if (!diagnostics.llmConfigured && savedArticles.length > 0) {
        diagnostics.extractionSkippedReason = "LLM_NOT_CONFIGURED";
      }

      const classifiedYesCount = (result.classifiedYes ?? []).length;
      const classifiedNoCount = (result.classifiedNo ?? []).length;

      sendJson(res, 200, {
        mode: result.mode ?? (query === "" ? "feed" : "search"),
        entryUrl: result.entryUrl ?? result.searchUrl ?? null,
        // legacy field name kept for tests/old callers
        searchUrl: result.searchUrl ?? result.entryUrl ?? null,
        discovered:
          (result.links?.length ?? 0) +
          (result.skipped?.length ?? 0) +
          (result.classifiedNo?.length ?? 0),
        classifiedYes: classifiedYesCount,
        classifiedNo: classifiedNoCount,
        classifyError: result.classifyError ?? null,
        candidates: result.candidates ?? [],
        classifiedYesUrls: result.classifiedYes ?? [],
        classifiedNoUrls: result.classifiedNo ?? [],
        saved: savedArticles, // legacy alias
        savedArticles,
        savedQuestions,
        skipped: result.skipped ?? [],
        skippedUrls: result.skipped ?? [],
        failed,
        prunedArticles,
        diagnostics
      });
    } catch (err) {
      sendError(res, err);
    }
  }

  return { handleNowCoderFetch };
}
