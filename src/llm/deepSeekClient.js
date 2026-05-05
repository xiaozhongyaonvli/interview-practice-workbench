// DeepSeek client — thin wrapper over the OpenAI SDK pointed at DeepSeek.
//
// We do NOT import OpenAI at module load time. The factory imports lazily
// so test environments without DEEPSEEK_API_KEY (or without the openai
// package) can still load this module and inject a mock chatComplete.
//
// Usage:
//   const chat = createDeepSeekChat({ apiKey: process.env.DEEPSEEK_API_KEY });
//   const reply = await chat("prompt body...");
//
// Errors are thrown verbatim — the caller (LlmEvaluationService) wraps
// them in ValidationError + records them to llmDebugStore.

const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

export function createDeepSeekChat({
  apiKey,
  model = DEFAULT_MODEL,
  baseURL = DEFAULT_BASE_URL,
  systemPrompt = "你是严格的中文技术面试评审,严格按要求只输出 JSON,不要带 markdown 代码块。",
  // Allow tests to inject a fake OpenAI client constructor.
  OpenAIClient = null,
  // Allow tests to override the request layer entirely with a single function.
  rawChat = null
} = {}) {
  if (rawChat) {
    return async (prompt, _options = {}) => {
      return await rawChat(prompt);
    };
  }

  if (!apiKey) {
    throw new Error("createDeepSeekChat: apiKey is required (set DEEPSEEK_API_KEY)");
  }

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
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ],
      stream: false
    });
    const content = completion?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("DeepSeek returned a non-string completion content");
    }
    return content;
  };
}
