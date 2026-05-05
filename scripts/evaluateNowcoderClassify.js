import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createDeepSeekChat } from "../src/llm/deepSeekClient.js";
import { createLlmEvaluationService } from "../src/llm/llmEvaluationService.js";
import { createPromptProvider } from "../src/llm/promptProvider.js";
import { createLlmDebugStore } from "../src/storage/llmDebugStore.js";

const DEFAULT_CASES = [
  { title: "腾讯 CSIG 后台开发 一面", expected: true },
  { title: "字节飞书测开一面", expected: true },
  { title: "美团 Java 二面问了 Redis、MySQL、线程池", expected: true },
  { title: "一面 1.volatile原理 2.ThreadLocal原理 3.Mysql事务隔离级别 4.手撕三数之和", expected: true },
  { title: "上来是手撕简单题，合并两个有序数组，然后问 gRPC、幂等、TCP 三次握手", expected: true },
  { title: "已 oc，后端开发面试复盘", expected: true },
  { title: "📍面试公司：四达时代 💻面试岗位：java ❓面试问题：HashMap、MVCC、线程池", expected: true },
  { title: "秋招倒计时：30天从零到一拿下前端实习（附完整冲刺路线）", expected: false },
  { title: "题解 | 每个月Top3的周杰伦歌曲", expected: false },
  { title: "春招 测试/测开", expected: false },
  { title: "难道现在已经是 agent 的天下了吗", expected: false },
  { title: "一位小镇做题家的自白", expected: false },
  { title: "28届后端小厂实习要去吗", expected: false },
  { title: "简历求建议，boss 投递没人理", expected: false },
  { title: "拼多多暑期实习内推，后端研发大量 hc", expected: false }
];

function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;
  const body = readFileSync(path, "utf8");
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const options = {
    dataDir: "data",
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      options.dataDir = String(argv[++i] ?? "").trim() || "data";
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function helpText() {
  return [
    "Usage: node scripts/evaluateNowcoderClassify.js [options]",
    "",
    "Runs the LLM title classifier against a small manually labeled NowCoder set.",
    "",
    "Options:",
    "  --data-dir <dir>      Debug log directory. Default: data",
    "  --json                Print machine-readable JSON summary.",
    "  --help                Show this help."
  ].join("\n");
}

function formatSummary(summary) {
  const lines = [
    `total=${summary.total}`,
    `correct=${summary.correct}`,
    `accuracy=${summary.accuracy}`,
    `falsePositive=${summary.falsePositive}`,
    `falseNegative=${summary.falseNegative}`,
    ""
  ];
  for (const r of summary.results) {
    const mark = r.pass ? "OK" : "MISS";
    lines.push(
      `[${mark}] expected=${r.expected} got=${r.got} confidence=${r.confidence ?? "n/a"} title=${r.title}`
    );
    if (r.reason) lines.push(`     reason=${r.reason}`);
  }
  return lines.join("\n");
}

export async function runEvaluation({ dataDir = "data" } = {}) {
  loadEnvFile();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured. Put it in .env or environment.");
  }

  const service = createLlmEvaluationService({
    chatComplete: createDeepSeekChat({ apiKey }),
    promptProvider: createPromptProvider(),
    llmDebugStore: createLlmDebugStore({ baseDir: dataDir })
  });

  const titles = DEFAULT_CASES.map((c) => c.title);
  const { flags, raw } = await service.classifyInterviewTitles({ titles });
  let parsed = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }

  const results = DEFAULT_CASES.map((c, i) => {
    const item = parsed.find((p) => p?.index === i) ?? {};
    const got = flags[i] === true;
    return {
      index: i,
      title: c.title,
      expected: c.expected,
      got,
      pass: got === c.expected,
      confidence: typeof item.confidence === "number" ? item.confidence : null,
      reason: typeof item.reason === "string" ? item.reason : ""
    };
  });

  const correct = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    correct,
    accuracy: Number((correct / results.length).toFixed(3)),
    falsePositive: results.filter((r) => !r.expected && r.got).length,
    falseNegative: results.filter((r) => r.expected && !r.got).length,
    results
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const summary = await runEvaluation(options);
  console.log(options.json ? JSON.stringify(summary, null, 2) : formatSummary(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack ?? err?.message ?? String(err));
    process.exitCode = 1;
  });
}

