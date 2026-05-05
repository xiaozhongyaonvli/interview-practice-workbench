import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createDeepSeekChat } from "../src/llm/deepSeekClient.js";
import { createLlmEvaluationService } from "../src/llm/llmEvaluationService.js";
import { createPromptProvider } from "../src/llm/promptProvider.js";
import { createLlmDebugStore } from "../src/storage/llmDebugStore.js";
import { readJsonlRecords } from "../src/storage/jsonlStore.js";

const DEFAULT_SOURCE_FILE = "data/articles/__feed__.jsonl";

const DEFAULT_CASES = [
  {
    sourceUrl: "https://www.nowcoder.com/discuss/878944913642045440",
    expectedInterview: true,
    expectedMinQuestions: 1,
    note: "本地已保存后端一面面经"
  },
  {
    sourceUrl: "https://www.nowcoder.com/discuss/878569217430253568",
    expectedInterview: true,
    expectedMinQuestions: 1,
    note: "本地已保存 Java 二面面经"
  },
  {
    sourceUrl: "https://www.nowcoder.com/discuss/879396691877642240",
    expectedInterview: true,
    expectedMinQuestions: 1,
    note: "本地已保存三面面经"
  },
  {
    sourceUrl: "https://www.nowcoder.com/feed/main/detail/a4c329410462440dbecb71aa6f151f99",
    expectedInterview: false,
    expectedMinQuestions: 0,
    note: "行业讨论/求职讨论"
  },
  {
    sourceUrl: "https://www.nowcoder.com/discuss/881160527496413184",
    expectedInterview: false,
    expectedMinQuestions: 0,
    note: "自述帖"
  },
  {
    sourceUrl: "https://www.nowcoder.com/feed/main/detail/d80fd3fd5d8747d0b58a0c530d969c90",
    expectedInterview: false,
    expectedMinQuestions: 0,
    note: "简历求助帖"
  }
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
    sourceFile: DEFAULT_SOURCE_FILE,
    dataDir: "data",
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-file") {
      options.sourceFile = String(argv[++i] ?? "").trim() || DEFAULT_SOURCE_FILE;
    } else if (arg === "--data-dir") {
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
    "Usage: node scripts/evaluateNowcoderExtraction.js [options]",
    "",
    "Runs the LLM extraction prompt against a few real locally saved NowCoder articles.",
    "",
    "Options:",
    "  --source-file <path>  JSONL article source file. Default: data/articles/__feed__.jsonl",
    "  --data-dir <dir>      LLM debug log directory. Default: data",
    "  --json                Print machine-readable JSON summary.",
    "  --help                Show this help."
  ].join("\n");
}

function questionLooksUsable(question) {
  const text = String(question ?? "").trim();
  return {
    nonEmpty: text.length > 0,
    questionLike: /[?？]$/.test(text) || /什么|如何|怎么|为什么|区别|原理|过程|实现|作用/u.test(text),
    notTooLong: text.length <= 80,
    notTooShort: text.length >= 6
  };
}

function summarizeCaseResult(result) {
  const pass =
    result.gotInterview === result.expectedInterview &&
    (result.expectedInterview ? result.questionCount >= result.expectedMinQuestions : result.questionCount === 0);
  return { ...result, pass };
}

function formatSummary(summary) {
  const lines = [
    `total=${summary.total}`,
    `passed=${summary.passed}`,
    `accuracy=${summary.accuracy}`,
    ""
  ];
  for (const r of summary.results) {
    lines.push(
      `[${r.pass ? "OK" : "MISS"}] expectedInterview=${r.expectedInterview} gotInterview=${r.gotInterview} questions=${r.questionCount} note=${r.note}`
    );
    lines.push(`     title=${r.title}`);
    if (r.error) {
      lines.push(`     error=${r.error}`);
      continue;
    }
    for (const q of r.questions.slice(0, 5)) {
      lines.push(`     - ${q.question}`);
    }
  }
  return lines.join("\n");
}

export async function runEvaluation({ sourceFile = DEFAULT_SOURCE_FILE, dataDir = "data" } = {}) {
  loadEnvFile();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured. Put it in .env or environment.");
  }

  const records = await readJsonlRecords(sourceFile);
  const byUrl = new Map(records.map((r) => [r.sourceUrl, r]));
  const service = createLlmEvaluationService({
    chatComplete: createDeepSeekChat({ apiKey }),
    promptProvider: createPromptProvider(),
    llmDebugStore: createLlmDebugStore({ baseDir: dataDir })
  });

  const rawResults = [];
  for (const testCase of DEFAULT_CASES) {
    const article = byUrl.get(testCase.sourceUrl);
    if (!article) {
      rawResults.push(
        summarizeCaseResult({
          ...testCase,
          title: "(missing locally)",
          gotInterview: false,
          questionCount: 0,
          questions: [],
          error: `article not found in ${sourceFile}`
        })
      );
      continue;
    }

    try {
      const { extraction } = await service.extractQuestions({
        query: article.query === "__feed__" ? "面经" : article.query,
        title: article.title,
        text: article.text
      });
      const questions = (extraction.questions ?? []).map((q) => ({
        ...q,
        usable: questionLooksUsable(q.question)
      }));
      rawResults.push(
        summarizeCaseResult({
          ...testCase,
          title: article.title,
          gotInterview: extraction.isInterview !== false,
          questionCount: questions.length,
          questions,
          error: null
        })
      );
    } catch (err) {
      rawResults.push(
        summarizeCaseResult({
          ...testCase,
          title: article.title,
          gotInterview: false,
          questionCount: 0,
          questions: [],
          error: err?.code ?? err?.message ?? String(err)
        })
      );
    }
  }

  const passed = rawResults.filter((r) => r.pass).length;
  return {
    total: rawResults.length,
    passed,
    accuracy: Number((passed / rawResults.length).toFixed(3)),
    results: rawResults
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
