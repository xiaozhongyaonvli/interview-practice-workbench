// Domain helpers for the retry loop:
//   - totalScore(summary)     -> arithmetic mean of the five rubric scores
//   - selectBestAttempt(list) -> the attempt with the highest total score;
//                                ties broken by latest createdAt
//   - scoreDelta(prev, curr)  -> per-key + total deltas, used by the
//                                front-end to render "↑ +1.2" badges
//
// Step 6 acceptance:
// - 总分计算正确
// - best attempt 选择正确
// - 平分时选择最新或按明确规则选择(我们选 createdAt 最新)

import { SCORE_KEYS } from "./scoreSummary.js";

/** Average of the five rubric scores; null when there is no summary. */
export function totalScore(summary) {
  if (!summary || !summary.scores) return null;
  let sum = 0;
  for (const k of SCORE_KEYS) {
    const v = summary.scores[k];
    if (typeof v !== "number" || Number.isNaN(v)) return null;
    sum += v;
  }
  return sum / SCORE_KEYS.length;
}

/**
 * Pick the "best" attempt from a list. An attempt is comparable only when it
 * carries a valid summary; un-scored attempts cannot be best.
 *
 * Tie-breaker: the latest createdAt wins, because that is the user's most
 * recent thinking and is more likely to be what they want to save.
 */
export function selectBestAttempt(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  let best = null;
  let bestTotal = -Infinity;
  for (const a of attempts) {
    const t = totalScore(a.summary);
    if (t === null) continue;
    if (
      t > bestTotal ||
      (t === bestTotal &&
        best !== null &&
        String(a.createdAt ?? "").localeCompare(String(best.createdAt ?? "")) > 0)
    ) {
      best = a;
      bestTotal = t;
    }
  }
  return best;
}

/**
 * Per-key + total delta from prev to curr. Both summaries must be valid.
 * Returns null when either is missing so callers can render "—" cleanly.
 */
export function scoreDelta(prev, curr) {
  if (!prev || !curr) return null;
  const prevTotal = totalScore(prev);
  const currTotal = totalScore(curr);
  if (prevTotal === null || currTotal === null) return null;
  const perKey = {};
  for (const k of SCORE_KEYS) {
    perKey[k] = curr.scores[k] - prev.scores[k];
  }
  return {
    total: currTotal - prevTotal,
    perKey
  };
}
