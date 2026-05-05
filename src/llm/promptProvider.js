// PromptProvider — single source of truth for LLM prompts.
//
// Templates live in prompts/*.md and use {{variable}} placeholders. Keeping
// prompts on disk (rather than as JS string literals) makes them easy to
// review, version, and hand to non-engineering reviewers without reading code.
//
// CEO review red-line: prompts must NOT scatter through UI or API code.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const promptsDir = fileURLToPath(new URL("../../prompts/", import.meta.url));
const cache = new Map();

async function loadTemplate(name) {
  if (cache.has(name)) return cache.get(name);
  const path = join(promptsDir, name);
  const body = await readFile(path, "utf8");
  cache.set(name, body);
  return body;
}

function renderTemplate(template, variables) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return String(variables[key] ?? "");
    }
    // Leave unknown placeholders untouched so prompt authors notice.
    return `{{${key}}}`;
  });
}

export function createPromptProvider({ basePath = promptsDir } = {}) {
  // Track basePath only so tests can swap a different directory.
  const localCache = new Map();
  async function load(name) {
    if (localCache.has(name)) return localCache.get(name);
    const path = join(basePath, name);
    const body = await readFile(path, "utf8");
    localCache.set(name, body);
    return body;
  }

  return {
    async extractionPrompt({ query, title, text }) {
      const tpl = await load("extraction.md");
      return renderTemplate(tpl, { query, title, text });
    },
    async scoringPrompt({ question, answer, context = "" }) {
      const tpl = await load("interview_coach_v2.md");
      return renderTemplate(tpl, { question, answer, context });
    }
  };
}

export const defaultPromptProvider = {
  async extractionPrompt(vars) {
    const tpl = await loadTemplate("extraction.md");
    return renderTemplate(tpl, vars);
  },
  async scoringPrompt({ question, answer, context = "" }) {
    const tpl = await loadTemplate("interview_coach_v2.md");
    return renderTemplate(tpl, { question, answer, context });
  }
};
