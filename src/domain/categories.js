// Allowed question / card categories.
//
// Source of truth: CLAUDE.md (老项目分类) + phase-a-practice-loop-requirements
// 第 6.4 节. Adding a new category requires updating both the front-end
// category nav and any extractor prompts. Do NOT silently widen this set.

export const ALLOWED_CATEGORIES = Object.freeze([
  "Redis",
  "Java",
  "MySQL",
  "计网",
  "计系统",
  "Agent"
]);

export function isAllowedCategory(value) {
  return typeof value === "string" && ALLOWED_CATEGORIES.includes(value);
}
