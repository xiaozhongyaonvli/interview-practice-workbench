const DEFAULT_SYSTEM_PROMPT =
  "你是严格的中文技术面试评审官，严格按要求只输出 JSON，不要带 markdown 代码块。";

const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_QWEN_MODEL = "qwen-plus";

export function createQwenChat({
  apiKey,
  baseURL = DEFAULT_QWEN_BASE_URL,
  model = DEFAULT_QWEN_MODEL,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  OpenAIClient = null,
  rawChat = null
} = {}) {
  if (rawChat) {
    return async (prompt) => {
      return await rawChat(prompt);
    };
  }

  if (!apiKey) {
    throw new Error("createQwenChat: apiKey is required (set LLM_API_KEY)");
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
      ]
    });
    const content = completion?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Qwen Chat Completions API returned a non-string completion content");
    }
    return content;
  };
}
