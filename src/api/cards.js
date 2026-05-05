// Cards API — sink for graduated practice records.
//
// POST /api/cards/from-attempt converts (Question + best Attempt + Score) into
// a CardRecord and stores it in the long-lived cards/ directory. This is the
// only path that writes to cards/*.json — neither articles, questions, nor
// attempts may modify the curated library.
//
// Step 7 acceptance:
// - Only scored attempts may be promoted.
// - category and difficulty must be confirmed by the caller.
// - cards/<id>.json is created.
// - cards/index.json is updated (delegated to cardStore).
// - Output passes validateCardRecord (matches interview-coach-v2).
// - Duplicate ids surface a visible rejection unless `overwrite: true`.

import { ValidationError } from "../domain/errors.js";
import { isAllowedCategory } from "../domain/categories.js";
import {
  isAllowedDifficulty,
  normalizeDifficulty
} from "../domain/difficulty.js";
import { readJsonBody, sendJson, sendError } from "./http.js";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function nowDate() {
  return new Date().toISOString().slice(0, 10);
}

function deriveCardId(question) {
  // Prefer the question id when it is already a safe slug; otherwise fall
  // back to a hash-style id derived from the question text. The question
  // store guarantees safe ids, so this is mostly a passthrough.
  if (SAFE_ID.test(question.id)) return question.id;
  let h = 0;
  for (let i = 0; i < question.question.length; i += 1) {
    h = (h * 31 + question.question.charCodeAt(i)) | 0;
  }
  return `card-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function createCardsApi({
  questionStore,
  attemptStore,
  scoreStore,
  cardStore,
  now = nowDate
}) {
  if (!questionStore) throw new Error("createCardsApi: questionStore required");
  if (!attemptStore) throw new Error("createCardsApi: attemptStore required");
  if (!scoreStore) throw new Error("createCardsApi: scoreStore required");
  if (!cardStore) throw new Error("createCardsApi: cardStore required");

  async function handleFromAttempt(req, res) {
    try {
      const body = await readJsonBody(req);

      if (typeof body.attemptId !== "string" || !SAFE_ID.test(body.attemptId)) {
        throw new ValidationError("attemptId must be a safe id", {
          code: "CARD_INPUT_INVALID",
          path: "attemptId"
        });
      }
      if (!isAllowedCategory(body.category)) {
        throw new ValidationError("category must be in the allowed list", {
          code: "CARD_INPUT_INVALID",
          path: "category"
        });
      }
      if (!isAllowedDifficulty(body.difficulty)) {
        throw new ValidationError(
          "difficulty must be easy/medium/hard or 简单/中等/困难",
          { code: "CARD_INPUT_INVALID", path: "difficulty" }
        );
      }
      const overwrite = body.overwrite === true;

      // Lookup attempt -> question -> latest score.
      const attempts = await attemptStore.listAll();
      const attempt = attempts.find((a) => a.attemptId === body.attemptId);
      if (!attempt) {
        throw new ValidationError(`attempt "${body.attemptId}" not found`, {
          code: "ATTEMPT_NOT_FOUND",
          path: "attemptId"
        });
      }

      const score = await scoreStore.latestForAttempt(attempt.attemptId);
      if (!score) {
        throw new ValidationError(
          "attempt has no score; cannot save as card",
          { code: "ATTEMPT_NOT_SCORED", path: "attemptId" }
        );
      }

      const questions = await questionStore.list();
      const question = questions.find((q) => q.id === attempt.questionId);
      if (!question) {
        throw new ValidationError(
          `question "${attempt.questionId}" not found`,
          { code: "QUESTION_NOT_FOUND", path: "questionId" }
        );
      }

      const id = body.cardId && SAFE_ID.test(body.cardId) ? body.cardId : deriveCardId(question);

      // Refuse silent overwrites unless explicitly opted in.
      if (!overwrite) {
        const existing = await cardStore.getById(id);
        if (existing) {
          throw new ValidationError(
            `card "${id}" already exists; pass overwrite: true to replace`,
            { code: "CARD_DUPLICATE_ID", path: "cardId" }
          );
        }
      }

      // Build the feedback block. Step 5 stores the user-visible summary in
      // ScoreRecord.summary. Card schema expects feedback.performanceScore
      // with the five rubric scores; we copy them verbatim and preserve
      // any long-form sections under feedback.* if the LLM produced them.
      const feedback = {
        performanceScore: {
          scores: { ...score.summary.scores },
          overallComment: score.summary.overallComment ?? ""
        },
        // Surface the three gap fields and retryInstruction so saved cards
        // remain useful for review, mirroring AttemptRecord's contract.
        primaryTechnicalGap: score.summary.primaryTechnicalGap,
        primaryExpressionGap: score.summary.primaryExpressionGap,
        engineeringMindsetGap: score.summary.engineeringMindsetGap,
        retryInstruction: score.summary.retryInstruction,
        ...(score.feedback && typeof score.feedback === "object" ? score.feedback : {})
      };

      const today = now();

      // Preserve the original card's createdAt when overwriting so the
      // user does not lose that signal.
      let createdAt = today;
      if (overwrite) {
        const prev = await cardStore.getById(id);
        if (prev?.createdAt) createdAt = prev.createdAt;
      }

      const tagSet = new Set(question.tags ?? []);
      tagSet.add(body.category);
      // Normalize difficulty to the legacy English form so the legacy
      // front-end can read both new and old cards uniformly.
      const normalizedDifficulty = normalizeDifficulty(body.difficulty);

      const record = {
        id,
        title: question.question,
        count: 0,
        category: body.category,
        tags: [...tagSet],
        difficulty: normalizedDifficulty,
        createdAt,
        updatedAt: today,
        question: question.question,
        myAnswer: attempt.answer,
        feedbackPromptVersion: score.feedbackPromptVersion ?? "interview-coach-v2",
        feedback
      };

      const saved = await cardStore.save(record);
      sendJson(res, 201, saved);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleList(req, res) {
    try {
      const index = await cardStore.listIndex();
      const cards = [];
      for (const filename of index) {
        const id = filename.replace(/\.json$/, "");
        const card = await cardStore.getById(id);
        if (card) cards.push(card);
      }
      sendJson(res, 200, { cards });
    } catch (err) {
      sendError(res, err);
    }
  }

  return { handleFromAttempt, handleList };
}
