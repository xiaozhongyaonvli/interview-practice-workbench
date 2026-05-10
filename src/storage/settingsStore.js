import { join } from "node:path";
import { readJsonObject, writeJsonObject } from "./jsonStore.js";
import { StorageError } from "../domain/errors.js";

const FILE_NAME = "settings.json";

const ALLOWED_API_STYLES = new Set(["responses", "chat_completions"]);

function normalizeString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function sanitizeLlmConfig(input) {
  if (!input || typeof input !== "object") return {};
  const apiKey = normalizeString(input.apiKey);
  const baseURL = normalizeString(input.baseURL);
  const model = normalizeString(input.model);
  const reasoningEffort = normalizeString(input.reasoningEffort);
  let apiStyle = normalizeString(input.apiStyle);
  if (apiStyle && !ALLOWED_API_STYLES.has(apiStyle)) {
    throw new StorageError(`unsupported apiStyle "${apiStyle}"`, {
      code: "SETTINGS_INVALID_API_STYLE"
    });
  }
  const out = {};
  if (apiKey) out.apiKey = apiKey;
  if (baseURL) out.baseURL = baseURL;
  if (model) out.model = model;
  if (apiStyle) out.apiStyle = apiStyle;
  if (reasoningEffort) out.reasoningEffort = reasoningEffort;
  return out;
}

export function createSettingsStore({ baseDir }) {
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new StorageError("baseDir is required", { code: "STORE_CONFIG_INVALID" });
  }
  const filePath = join(baseDir, FILE_NAME);

  return {
    async read() {
      const raw = await readJsonObject(filePath, { defaultValue: { llm: {} } });
      const llm = raw && typeof raw.llm === "object" && raw.llm ? raw.llm : {};
      return { llm: sanitizeLlmConfig(llm) };
    },

    async writeLlm(patch) {
      const sanitized = sanitizeLlmConfig(patch);
      const next = { llm: sanitized };
      await writeJsonObject(filePath, next);
      return next;
    }
  };
}
