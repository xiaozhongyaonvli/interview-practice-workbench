// OpenAI-compatible LLM client anti-corruption layer.
//
// Goal:
// - isolate provider-specific wire details from the rest of the app
// - support multiple OpenAI-compatible backends via env-only switches
//
// Supported request styles:
// - `responses`         -> OpenAI Responses-style API
// - `chat_completions`  -> OpenAI Chat Completions-style API

const DEFAULT_SYSTEM_PROMPT =
  "你是严格的中文技术面试评审官，严格按要求只输出 JSON，不要带 markdown 代码块。";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-5.2";
const DEFAULT_OPENAI_STYLE = "responses";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_DEEPSEEK_STYLE = "chat_completions";

function providerDefaults(baseURL) {
  const normalized = String(baseURL ?? "").trim().toLowerCase();
  if (normalized.includes("deepseek.com")) {
    return {
      model: DEFAULT_DEEPSEEK_MODEL,
      apiStyle: DEFAULT_DEEPSEEK_STYLE
    };
  }
  return {
    model: DEFAULT_OPENAI_MODEL,
    apiStyle: DEFAULT_OPENAI_STYLE
  };
}

function normalizeApiStyle(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "responses") return "responses";
  if (raw === "chat" || raw === "chat_completions" || raw === "chat-completions") {
    return "chat_completions";
  }
  throw new Error(`Unsupported LLM_API_STYLE "${value}"`);
}

function extractTextFromResponsesApi(response) {
  if (typeof response?.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.length > 0) return part.text;
      if (typeof part?.output_text === "string" && part.output_text.length > 0) {
        return part.output_text;
      }
    }
  }
  throw new Error("Responses API returned no text output");
}

export function createOpenAiCompatibleChat({
  apiKey,
  baseURL = DEFAULT_OPENAI_BASE_URL,
  model = null,
  apiStyle = null,
  reasoningEffort = null,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  OpenAIClient = null,
  rawChat = null
} = {}) {
  if (rawChat) {
    return async (prompt, _options = {}) => {
      return await rawChat(prompt);
    };
  }

  if (!apiKey) {
    throw new Error("createOpenAiCompatibleChat: apiKey is required (set LLM_API_KEY)");
  }

  const defaults = providerDefaults(baseURL);
  const resolvedModel = model && String(model).trim().length > 0 ? model : defaults.model;
  const resolvedStyle =
    apiStyle && String(apiStyle).trim().length > 0 ? apiStyle : defaults.apiStyle;
  const normalizedStyle = normalizeApiStyle(resolvedStyle);

  let clientPromise = null;
  async function getClient() {
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      const Ctor = OpenAIClient ?? (await import("openai")).default;
      return new Ctor({ apiKey, baseURL });
    })();
    return clientPromise;
  }

  return async function chatComplete(prompt) {
    const client = await getClient();
    if (normalizedStyle === "responses") {
      const response = await client.responses.create({
        model: resolvedModel,
        reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
        stream: false,
        input: [
          {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }]
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: prompt }]
          }
        ]
      });
      return extractTextFromResponsesApi(response);
    }

    const completion = await client.chat.completions.create({
      model: resolvedModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ]
    });
    const content = completion?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Chat Completions API returned a non-string completion content");
    }
    return content;
  };
}

export function createDeepSeekChat({
  apiKey,
  model = DEFAULT_DEEPSEEK_MODEL,
  baseURL = "https://api.deepseek.com",
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  OpenAIClient = null,
  rawChat = null
} = {}) {
  return createOpenAiCompatibleChat({
    apiKey,
    model,
    baseURL,
    apiStyle: "chat_completions",
    systemPrompt,
    OpenAIClient,
    rawChat
  });
}
