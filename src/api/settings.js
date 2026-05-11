import { readJsonBody, sendJson, sendError } from "./http.js";
import { ValidationError } from "../domain/errors.js";

const ALLOWED_API_STYLES = new Set(["responses", "chat_completions"]);

function maskApiKey(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

function buildLlmView(llm) {
  const cfg = llm ?? {};
  return {
    apiKeyPresent: Boolean(cfg.apiKey),
    apiKeyMasked: maskApiKey(cfg.apiKey),
    baseURL: cfg.baseURL ?? "",
    model: cfg.model ?? "",
    apiStyle: cfg.apiStyle ?? "",
    reasoningEffort: cfg.reasoningEffort ?? ""
  };
}

function normalizeIncoming(body, current) {
  const next = { ...current };

  // apiKey: only overwrite when the client sent a non-empty string. Sending
  // null/empty string explicitly clears the saved key.
  if (Object.prototype.hasOwnProperty.call(body, "apiKey")) {
    const raw = body.apiKey;
    if (raw === null || raw === "") {
      delete next.apiKey;
    } else if (typeof raw === "string" && raw.trim().length > 0) {
      next.apiKey = raw.trim();
    } else if (raw !== undefined) {
      throw new ValidationError("apiKey must be a string", {
        code: "SETTINGS_INPUT_INVALID",
        path: "apiKey"
      });
    }
  }

  for (const key of ["baseURL", "model", "reasoningEffort"]) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const raw = body[key];
    if (raw === null || raw === "") {
      delete next[key];
      continue;
    }
    if (typeof raw !== "string") {
      throw new ValidationError(`${key} must be a string`, {
        code: "SETTINGS_INPUT_INVALID",
        path: key
      });
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      delete next[key];
    } else {
      next[key] = trimmed;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "apiStyle")) {
    const raw = body.apiStyle;
    if (raw === null || raw === "") {
      delete next.apiStyle;
    } else if (typeof raw === "string" && ALLOWED_API_STYLES.has(raw.trim())) {
      next.apiStyle = raw.trim();
    } else {
      throw new ValidationError(
        `apiStyle must be one of: ${[...ALLOWED_API_STYLES].join(", ")}`,
        { code: "SETTINGS_INPUT_INVALID", path: "apiStyle" }
      );
    }
  }

  return next;
}

export function createSettingsApi({ settingsStore, onLlmConfigChange = () => {} }) {
  if (!settingsStore) throw new Error("createSettingsApi: settingsStore is required");

  async function handleGetLlm(_req, res) {
    try {
      const settings = await settingsStore.read();
      sendJson(res, 200, { llm: buildLlmView(settings.llm) });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleUpdateLlm(req, res) {
    try {
      const body = await readJsonBody(req);
      const current = (await settingsStore.read()).llm ?? {};
      const next = normalizeIncoming(body, current);
      const saved = await settingsStore.writeLlm(next);
      onLlmConfigChange(saved.llm);
      sendJson(res, 200, { llm: buildLlmView(saved.llm) });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleFetchModels(_req, res) {
    try {
      const settings = await settingsStore.read();
      const cfg = settings.llm ?? {};
      const apiKey = cfg.apiKey;
      if (!apiKey) {
        sendJson(res, 200, { models: [], message: "未配置 API Key" });
        return;
      }

      const baseURL = (cfg.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
      // OpenAI-compatible APIs expect GET /v1/models. Ensure /v1 is in the
      // path when the base URL doesn't already end with it.
      const modelsURL = baseURL.endsWith("/v1")
        ? `${baseURL}/models`
        : `${baseURL}/v1/models`;
      const response = await fetch(modelsURL, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        sendJson(res, 200, {
          models: [],
          message: `请求失败: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
        });
        return;
      }

      const data = await response.json();
      const models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => typeof id === "string" && id.length > 0)
        .sort();
      sendJson(res, 200, { models });
    } catch (err) {
      sendError(res, err);
    }
  }

  return { handleGetLlm, handleUpdateLlm, handleFetchModels };
}
