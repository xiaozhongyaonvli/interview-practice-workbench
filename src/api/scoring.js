// Scoring API — POST a score for an existing attempt.
//
// Step 5 is "manual paste" mode: the user pastes the LLM's scoring JSON.
// Step 9 will swap in a real LLM call but keep this exact handler shape.
// Either path validates against ScoreSummary first; on failure we persist
// the raw payload to the LLM debug log so the user can fix and retry.

import { ValidationError } from "../domain/errors.js";
import { validateScoreSummary } from "../domain/scoreSummary.js";
import { readJsonBody, sendJson, sendError } from "./http.js";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const DEFAULT_PROMPT_VERSION = "interview-coach-v2";

function nowIso() {
  return new Date().toISOString();
}

export function createScoringApi({
  attemptStore,
  scoreStore,
  llmDebugStore,
  questionStore = null,
  llmService = null,
  now = nowIso
}) {
  if (!attemptStore) throw new Error("createScoringApi: attemptStore is required");
  if (!scoreStore) throw new Error("createScoringApi: scoreStore is required");
  if (!llmDebugStore) throw new Error("createScoringApi: llmDebugStore is required");

  async function handleScore(req, res, attemptId) {
    try {
      if (!SAFE_ID.test(attemptId)) {
        throw new ValidationError("attemptId must contain only A-Za-z0-9_-", {
          code: "SCORE_INPUT_INVALID",
          path: "attemptId"
        });
      }

      // The attempt MUST exist before we accept a score. Reject 404-ish
      // cases as 409 (USER_FACING) so the front-end can show a real
      // message rather than treat it as a network error.
      const all = await attemptStore.listAll();
      const target = all.find((a) => a.attemptId === attemptId);
      if (!target) {
        throw new ValidationError(`attempt "${attemptId}" not found`, {
          code: "ATTEMPT_NOT_FOUND",
          path: "attemptId"
        });
      }

      const body = await readJsonBody(req);

      // Two intake shapes:
      //   1) { summary, feedback?, feedbackPromptVersion? }  parsed-already
      //   2) { rawResponse: "...JSON..." }                   raw paste
      let summary = body.summary ?? null;
      let feedback = body.feedback ?? null;
      const promptVersion = body.feedbackPromptVersion ?? DEFAULT_PROMPT_VERSION;
      const rawResponse = typeof body.rawResponse === "string" ? body.rawResponse : null;

      if (summary === null && rawResponse !== null) {
        let parsed;
        try {
          parsed = JSON.parse(rawResponse);
        } catch (parseErr) {
          await llmDebugStore.appendRaw({
            phase: "scoring",
            requestMeta: { attemptId },
            rawResponse,
            error: { code: "SCORING_NOT_JSON", message: parseErr.message }
          });
          throw new ValidationError("rawResponse is not valid JSON", {
            code: "SCORING_NOT_JSON",
            path: "rawResponse"
          });
        }
        // The scoring prompt is expected to return an object that already
        // matches ScoreSummary plus an optional `feedback` block. Accept
        // both flat-summary and nested { summary, feedback } shapes.
        if (parsed.summary && typeof parsed.summary === "object") {
          summary = parsed.summary;
          feedback = feedback ?? parsed.feedback ?? null;
        } else {
          summary = parsed;
        }
      }

      if (summary === null) {
        throw new ValidationError(
          "body must contain either summary or rawResponse",
          { code: "SCORE_INPUT_INVALID", path: "summary" }
        );
      }

      try {
        validateScoreSummary(summary);
      } catch (err) {
        await llmDebugStore.appendRaw({
          phase: "scoring",
          requestMeta: { attemptId },
          rawResponse: rawResponse ?? JSON.stringify(summary),
          parsed: summary,
          error: err
        });
        throw err;
      }

      const record = {
        attemptId,
        scoredAt: now(),
        feedbackPromptVersion: promptVersion,
        summary,
        feedback: feedback ?? null
      };

      await scoreStore.append(record);
      sendJson(res, 201, record);
    } catch (err) {
      sendError(res, err);
    }
  }

  return { handleScore, handleLlmScore };

  /**
   * POST /api/attempts/:id/llm-score
   *
   * Auto-score using the real LLM. Pulls question + attempt + (optional)
   * context, asks the model, validates the response, and writes the score
   * record. On failure (non-JSON, missing gap fields, etc.) the raw response
   * stays in data/llm/scoring_results.jsonl for the user to inspect.
   */
  async function handleLlmScore(req, res, attemptId) {
    try {
      if (!llmService || !questionStore) {
        throw new ValidationError(
          "LLM scoring is not configured (set DEEPSEEK_API_KEY)",
          { code: "LLM_NOT_CONFIGURED", path: "service" }
        );
      }
      if (!SAFE_ID.test(attemptId)) {
        throw new ValidationError("attemptId must contain only A-Za-z0-9_-", {
          code: "SCORE_INPUT_INVALID",
          path: "attemptId"
        });
      }

      const all = await attemptStore.listAll();
      const attempt = all.find((a) => a.attemptId === attemptId);
      if (!attempt) {
        throw new ValidationError(`attempt "${attemptId}" not found`, {
          code: "ATTEMPT_NOT_FOUND",
          path: "attemptId"
        });
      }

      const questions = await questionStore.list();
      const question = questions.find((q) => q.id === attempt.questionId);
      if (!question) {
        throw new ValidationError(`question "${attempt.questionId}" not found`, {
          code: "QUESTION_NOT_FOUND",
          path: "questionId"
        });
      }

      const { summary } = await llmService.scoreAnswer({
        question: question.question,
        answer: attempt.answer,
        context: question.evidence ?? ""
      });

      const record = {
        attemptId,
        scoredAt: now(),
        feedbackPromptVersion: DEFAULT_PROMPT_VERSION,
        summary,
        feedback: null
      };
      await scoreStore.append(record);
      sendJson(res, 201, record);
    } catch (err) {
      sendError(res, err);
    }
  }
}
