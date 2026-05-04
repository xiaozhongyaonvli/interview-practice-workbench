// Difficulty representation.
//
// The legacy cards/*.json files use English literals ("medium" / "easy" /
// "hard"), while phase-a-practice-loop-requirements writes Chinese labels
// ("中等" / "简单" / "困难"). To keep both readable, this module accepts BOTH
// vocabularies on input and exposes a normalize() helper that returns the
// English canonical form.
//
// Front-end rendering is responsible for mapping back to Chinese for display.

const CANONICAL = Object.freeze(["easy", "medium", "hard"]);

const ALIASES = Object.freeze({
  easy: "easy",
  medium: "medium",
  hard: "hard",
  简单: "easy",
  中等: "medium",
  困难: "hard"
});

export const ALLOWED_DIFFICULTIES = CANONICAL;

export function isAllowedDifficulty(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ALIASES, value);
}

export function normalizeDifficulty(value) {
  if (!isAllowedDifficulty(value)) {
    return null;
  }
  return ALIASES[value];
}
