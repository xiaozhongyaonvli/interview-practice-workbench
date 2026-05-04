// ExtractionResult — the structured shape we expect from an LLM (or a human
// who pastes its output as JSON) when extracting interview questions from
// an article. Validation is strict: the question pool is the foundation of
// every later step, so a malformed extraction must NEVER reach storage.
//
// Reference: phase-a-practice-loop-requirements §7.1, phase-a-implementation-plan
// Step 3 schema test "缺少 question 失败" / "非技术问题标记失败".
//
// Shape (keep in sync with the prompt template that produces it):
//
//   {
//     "questions": [
//       {
//         "question":   "...",      // required, non-empty
//         "category":   "MySQL",    // required, in ALLOWED_CATEGORIES
//         "difficulty": "medium",   // required, accepts en + zh
//         "evidence":   "...",      // optional but recommended
//         "confidence": 0.86,       // required, [0, 1]
//         "isTechnical": true       // optional; when present and false the
//                                   // item is rejected per Step 3 acceptance
//       },
//       ...
//     ]
//   }

import { ValidationError } from "./errors.js";
import { isAllowedCategory } from "./categories.js";
import { isAllowedDifficulty } from "./difficulty.js";

function fail(path, message, value) {
  throw new ValidationError(`ExtractionResult.${path}: ${message}`, {
    code: "EXTRACTION_INVALID",
    path,
    value
  });
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate the parsed extraction result. Throws ValidationError on the first
 * failure. Returns the input unchanged on success.
 */
export function validateExtractionResult(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("", "must be an object", parsed);
  }
  if (!Array.isArray(parsed.questions)) {
    fail("questions", "must be an array", parsed.questions);
  }
  if (parsed.questions.length === 0) {
    fail("questions", "must contain at least one question", parsed.questions);
  }

  parsed.questions.forEach((q, index) => {
    const prefix = `questions[${index}]`;
    if (q === null || typeof q !== "object" || Array.isArray(q)) {
      fail(prefix, "must be an object", q);
    }
    if (!isNonEmptyString(q.question)) {
      fail(`${prefix}.question`, "must be a non-empty string", q.question);
    }
    if (!isAllowedCategory(q.category)) {
      fail(`${prefix}.category`, "is not in the allowed category list", q.category);
    }
    if (!isAllowedDifficulty(q.difficulty)) {
      fail(`${prefix}.difficulty`, "must be easy/medium/hard or 简单/中等/困难", q.difficulty);
    }
    if (q.evidence !== undefined && q.evidence !== null && typeof q.evidence !== "string") {
      fail(`${prefix}.evidence`, "must be a string when present", q.evidence);
    }
    if (typeof q.confidence !== "number" || Number.isNaN(q.confidence)) {
      fail(`${prefix}.confidence`, "must be a number", q.confidence);
    }
    if (q.confidence < 0 || q.confidence > 1) {
      fail(`${prefix}.confidence`, "must be in [0, 1]", q.confidence);
    }
    if (q.isTechnical !== undefined) {
      if (typeof q.isTechnical !== "boolean") {
        fail(`${prefix}.isTechnical`, "must be a boolean when present", q.isTechnical);
      }
      if (q.isTechnical === false) {
        fail(
          `${prefix}.isTechnical`,
          "non-technical questions are rejected; the LLM must not include them",
          q.isTechnical
        );
      }
    }
  });

  return parsed;
}

const SAFE_FRAGMENT = /[^A-Za-z0-9_-]+/g;

function slugFromQuestion(question, max = 48) {
  // Best-effort id slug. Pure ASCII; Chinese question text collapses to
  // empty so we fall back to a hash-style suffix at the call site.
  return question.trim().slice(0, max).replace(SAFE_FRAGMENT, "-").replace(/^-+|-+$/g, "");
}

function shortHash(input) {
  // Tiny non-cryptographic hash to disambiguate questions with the same slug.
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return ((h >>> 0).toString(16)).padStart(8, "0").slice(0, 8);
}

/**
 * Convert one extraction question into a full QuestionRecord. Caller provides
 * provenance fields that the LLM should not be allowed to spoof (query,
 * source, sourceUrl, sourceTitle).
 */
export function extractionItemToQuestionRecord(item, provenance, { now }) {
  const baseSlug = slugFromQuestion(item.question);
  const hash = shortHash(item.question);
  const id = baseSlug.length > 0 ? `${provenance.query}-${baseSlug}-${hash}` : `${provenance.query}-${hash}`;

  const tagSet = new Set();
  if (Array.isArray(item.tags)) {
    for (const t of item.tags) {
      if (typeof t === "string" && t.trim().length > 0) tagSet.add(t.trim());
    }
  }
  // Always tag with the category so the front-end filter matches.
  tagSet.add(item.category);

  return {
    id,
    question: item.question.trim(),
    category: item.category,
    tags: [...tagSet],
    difficulty: item.difficulty,
    source: provenance.source,
    sourceUrl: provenance.sourceUrl ?? null,
    sourceTitle: provenance.sourceTitle ?? null,
    evidence: item.evidence ?? null,
    query: provenance.query,
    confidence: item.confidence,
    status: "candidate",
    createdAt: now,
    updatedAt: now
  };
}
