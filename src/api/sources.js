// Sources API — POST /api/sources/nowcoder/fetch.
//
// Flow (per docs/phase-a-fetch-and-persistence-improvements.md):
//   1. prune nowcoder ArticleRecord older than TTL_DAYS (default 14).
//   2. auto-purge ignored questions so the pool never lingers long-term.
//   3. resolve effective query: missing/empty -> "" (feed mode).
//   4. compute partitionQuery + per-day cursorKey.
//   5. read crawlCursorStore for the offset to start at today.
//   6. compute excludeUrls from articleStore for that query partition.
//   7. delegate to nowCoderAdapter.searchAndFetch with offset + classifyTitles.
//      Adapter returns post-classify records and `nextOffset` based on the
//      candidate slice it consumed.
//   8. for each surviving record: append to articleStore, then immediately
//      call llmService.extractQuestions on the article body and persist the
//      resulting QuestionRecords.
//   9. when adapter consumed at least one candidate (fresh.length > 0):
//      advance the cursor; otherwise mark exhaustedToday: true.
//
// LLM service is optional. If absent, classification is skipped (treat all as
// interview) and extraction also skipped — caller can still get article bodies
// to drive a manual paste-JSON flow if they really want.

import { ValidationError } from "../domain/errors.js";
import { extractionItemToQuestionRecord } from "../domain/extraction.js";
import { FEED_QUERY_SENTINEL } from "../sources/nowcoderAdapter.js";
import { autoPurgeIgnored } from "./questions.js";
import { readJsonBody, sendJson, sendError } from "./http.js";

// Hard cap: every fetch returns at most this many fresh articles. The UI no
// longer exposes a knob — 2 is enough for one LLM extraction round and keeps
// the tab-switch loop snappy.
const NOWCODER_MAX_ARTICLES_PER_FETCH = 2;

// Empty string is allowed (feed mode); otherwise only safe word chars.
const SAFE_QUERY_OR_EMPTY = /^[\p{L}\p{N}_-]{0,64}$/u;

function randomSuffix() {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function generateNowCoderId(query) {
  const slug = query === "" ? "feed" : query;
  return `nowcoder-${slug}-${Date.now().toString(36)}-${randomSuffix()}`;
}

// Local-timezone YYYY-MM-DD with explicit two-digit padding. We avoid
// toLocaleDateString (locale-dependent separators) and toISOString (UTC drift
// near midnight). The dateKey is computed once per request so a fetch that
// straddles midnight stays consistent.
function defaultLocalDateKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function createSourcesApi({
  nowCoderAdapter,
  articleStore,
  questionStore = null,
  crawlCursorStore = null,
  llmService = null,
  ttlDays = 14,
  now = () => new Date().toISOString(),
  today = defaultLocalDateKey
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
      // body.maxArticles is intentionally ignored — the constant rules to
      // keep the UI honest. We accept the field silently for back-compat.

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

      // 2. Auto-purge ignored questions before any new questions land.
      const purgedIgnored = questionStore ? await autoPurgeIgnored(questionStore) : 0;

      // 3-4. Resolve partition + per-day cursor key. Compute dateKey ONCE so
      // a fetch crossing local midnight does not split itself across two
      // cursor files.
      const partitionQuery = query === "" ? FEED_QUERY_SENTINEL : query;
      const mode = query === "" ? "feed" : "search";
      const dateKey = today();
      const cursorKey = `${mode}-${partitionQuery}-${dateKey}`;

      // 5. Read today's offset (defaults to 0 on first hit / new day / cursor
      // store missing). Failure to read is non-fatal: fall back to 0 and let
      // URL dedup do the heavy lifting.
      let cursorOffset = 0;
      if (crawlCursorStore && typeof crawlCursorStore.get === "function") {
        try {
          const cursor = await crawlCursorStore.get(cursorKey);
          if (Number.isInteger(cursor?.nextOffset) && cursor.nextOffset >= 0) {
            cursorOffset = cursor.nextOffset;
          }
        } catch (cursorErr) {
          // eslint-disable-next-line no-console
          console.warn(
            "crawlCursorStore.get failed (continuing with offset 0):",
            cursorErr?.message ?? cursorErr
          );
        }
      }

      // 6. Compute exclusion set from the matching query partition.
      let excludeUrls = [];
      try {
        const existing = await articleStore.listByQuery(partitionQuery);
        excludeUrls = existing
          .map((a) => a.sourceUrl)
          .filter((u) => typeof u === "string" && u.length > 0);
      } catch {
        excludeUrls = [];
      }

      // 7. Bind classifier (only when LLM service is available).
      let classifyTitles = null;
      if (llmService && typeof llmService.classifyInterviewTitles === "function") {
        classifyTitles = async (titles) => {
          const out = await llmService.classifyInterviewTitles({ titles });
          return out.flags;
        };
      }

      // 8. Delegate to adapter — pinned to the constant cap.
      const result = await nowCoderAdapter.searchAndFetch({
        query,
        maxArticles: NOWCODER_MAX_ARTICLES_PER_FETCH,
        offset: cursorOffset,
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
        articleTextStats: [],
        cursor: {
          key: cursorKey,
          dateKey,
          mode,
          offsetBefore: cursorOffset,
          offsetAfter: cursorOffset,
          advanced: false,
          writeError: null
        }
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

        // 9. Auto-extract questions from this article (if LLM + store wired).
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

      // Cursor advancement uses adapter-reported nextOffset. The adapter
      // computes nextOffset = offset + fresh.length where fresh is the
      // post-exclude pre-classify slice — so the cursor still advances when
      // classify rejects every title, avoiding re-judging the same batch.
      // We treat "no fresh candidates" (links + records both empty) as
      // exhausted-for-today, and infer a fallback nextOffset from the
      // visible candidate count when an older adapter omits it.
      const freshCount = Array.isArray(result?.links)
        ? result.links.length
        : Array.isArray(result?.records)
          ? result.records.length
          : 0;
      const adapterNextOffset = Number.isInteger(result?.nextOffset)
        ? result.nextOffset
        : cursorOffset + freshCount;
      const exhaustedToday = freshCount === 0;
      if (
        !exhaustedToday &&
        crawlCursorStore &&
        typeof crawlCursorStore.set === "function"
      ) {
        try {
          await crawlCursorStore.set(cursorKey, { nextOffset: adapterNextOffset });
          diagnostics.cursor.offsetAfter = adapterNextOffset;
          diagnostics.cursor.advanced = true;
        } catch (cursorErr) {
          // Non-fatal: URL dedup will still keep us from double-saving.
          // eslint-disable-next-line no-console
          console.warn(
            "crawlCursorStore.set failed (continuing):",
            cursorErr?.message ?? cursorErr
          );
          diagnostics.cursor.writeError =
            cursorErr?.message ?? String(cursorErr);
        }
      }

      const classifiedYesCount = (result.classifiedYes ?? []).length;
      const classifiedNoCount = (result.classifiedNo ?? []).length;

      sendJson(res, 200, {
        mode: result.mode ?? mode,
        partitionQuery,
        dateKey,
        exhaustedToday,
        purgedIgnored,
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

export { NOWCODER_MAX_ARTICLES_PER_FETCH };
