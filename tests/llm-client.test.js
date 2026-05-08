import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiCompatibleChat, createDeepSeekChat } from "../src/llm/deepSeekClient.js";
import { createQwenChat } from "../src/llm/qwenClient.js";

test("responses style client extracts output_text", async () => {
  class FakeOpenAI {
    constructor(config) {
      this.config = config;
      this.responses = {
        create: async (payload) => {
          assert.equal(this.config.apiKey, "key");
          assert.equal(this.config.baseURL, "https://www.dogapi.cc/v1");
          assert.equal(payload.model, "gpt-5.2");
          assert.equal(payload.reasoning.effort, "high");
          return {
            output_text: '{"ok":true}'
          };
        }
      };
    }
  }

  const chat = createOpenAiCompatibleChat({
    apiKey: "key",
    baseURL: "https://www.dogapi.cc/v1",
    model: "gpt-5.2",
    apiStyle: "responses",
    reasoningEffort: "high",
    OpenAIClient: FakeOpenAI
  });

  const result = await chat("hello");
  assert.equal(result, '{"ok":true}');
});

test("responses style client falls back to output content text", async () => {
  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: async () => ({
          output: [
            {
              content: [{ type: "output_text", text: '{"kind":"fallback"}' }]
            }
          ]
        })
      };
    }
  }

  const chat = createOpenAiCompatibleChat({
    apiKey: "key",
    apiStyle: "responses",
    OpenAIClient: FakeOpenAI
  });

  const result = await chat("hello");
  assert.equal(result, '{"kind":"fallback"}');
});

test("chat_completions style client returns message content", async () => {
  class FakeOpenAI {
    constructor(config) {
      this.config = config;
      this.chat = {
        completions: {
          create: async (payload) => {
            assert.equal(this.config.apiKey, "key");
            assert.equal(this.config.baseURL, "https://api.deepseek.com");
            assert.equal(payload.model, "deepseek-chat");
            return {
              choices: [{ message: { content: '{"ok":"chat"}' } }]
            };
          }
        }
      };
    }
  }

  const chat = createOpenAiCompatibleChat({
    apiKey: "key",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiStyle: "chat_completions",
    OpenAIClient: FakeOpenAI
  });

  const result = await chat("hello");
  assert.equal(result, '{"ok":"chat"}');
});

test("legacy createDeepSeekChat maps to chat_completions preset", async () => {
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async () => ({
            choices: [{ message: { content: '{"legacy":true}' } }]
          })
        }
      };
    }
  }

  const chat = createDeepSeekChat({
    apiKey: "legacy-key",
    OpenAIClient: FakeOpenAI
  });

  const result = await chat("hello");
  assert.equal(result, '{"legacy":true}');
});

test("qwen client uses chat completions payload aligned with provider example", async () => {
  class FakeOpenAI {
    constructor(config) {
      this.config = config;
      this.chat = {
        completions: {
          create: async (payload) => {
            assert.equal(this.config.apiKey, "qwen-key");
            assert.equal(
              this.config.baseURL,
              "https://dashscope.aliyuncs.com/compatible-mode/v1"
            );
            assert.deepEqual(Object.keys(payload).sort(), ["messages", "model"]);
            assert.equal(payload.model, "qwen-plus");
            assert.equal(payload.messages[0].role, "system");
            assert.equal(payload.messages[1].role, "user");
            return {
              choices: [{ message: { content: '{"provider":"qwen"}' } }]
            };
          }
        }
      };
    }
  }

  const chat = createQwenChat({
    apiKey: "qwen-key",
    model: "qwen-plus",
    OpenAIClient: FakeOpenAI
  });

  const result = await chat("hello");
  assert.equal(result, '{"provider":"qwen"}');
});
