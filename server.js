import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createArticleStore } from "./src/storage/articleStore.js";
import { createQuestionStore } from "./src/storage/questionStore.js";
import { createAttemptStore } from "./src/storage/attemptStore.js";
import { createScoreStore } from "./src/storage/scoreStore.js";
import { createCardStore } from "./src/storage/cardStore.js";
import { createLlmDebugStore } from "./src/storage/llmDebugStore.js";
import { createCrawlCursorStore } from "./src/storage/crawlCursorStore.js";
import { createNowCoderAdapter } from "./src/sources/nowcoderAdapter.js";
import { defaultPromptProvider } from "./src/llm/promptProvider.js";
import { createDeepSeekChat } from "./src/llm/deepSeekClient.js";
import { createLlmEvaluationService } from "./src/llm/llmEvaluationService.js";
import { createArticleApi } from "./src/api/articles.js";
import { createQuestionApi } from "./src/api/questions.js";
import { createAttemptApi } from "./src/api/attempts.js";
import { createScoringApi } from "./src/api/scoring.js";
import { createCardsApi } from "./src/api/cards.js";
import { createSourcesApi } from "./src/api/sources.js";
import { sendJson } from "./src/api/http.js";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(rootDir, "public");
const DEFAULT_BASE_DIR = join(rootDir, "data");

function loadLocalEnvFile(envPath = join(rootDir, ".env")) {
  if (!existsSync(envPath)) return { loaded: false, keys: [] };
  const body = readFileSync(envPath, "utf8");
  const keys = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, keys };
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function resolveStaticPath(pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    return null;
  }

  return filePath;
}

/**
 * Build the HTTP server.
 *
 * baseDir defaults to <project>/data so the running server persists below the
 * project root. Tests inject a tmp directory to keep state isolated.
 *
 * Stores and APIs are wired up here rather than at module top level so each
 * call to createAppServer gets its own store instances — important for
 * concurrent test runs.
 */
export function createAppServer({
  baseDir = DEFAULT_BASE_DIR,
  nowCoderAdapter,
  llmService = null
} = {}) {
  const articleStore = createArticleStore({ baseDir });
  const questionStore = createQuestionStore({ baseDir });
  const attemptStore = createAttemptStore({ baseDir });
  const scoreStore = createScoreStore({ baseDir });
  const cardStore = createCardStore({ baseDir });
  const llmDebugStore = createLlmDebugStore({ baseDir });
  const crawlCursorStore = createCrawlCursorStore({ baseDir });
  // The caller can inject a mock adapter in tests; production uses the real
  // adapter wired to Node's global fetch.
  const nowCoder = nowCoderAdapter ?? createNowCoderAdapter();

  // LLM service is optional. Three intake paths:
  //   1) caller injects a service (tests)
  //   2) DEEPSEEK_API_KEY is set in env (production)
  //   3) neither — routes that need LLM return LLM_NOT_CONFIGURED 400
  let resolvedLlmService = llmService;
  if (!resolvedLlmService && process.env.DEEPSEEK_API_KEY) {
    const chat = createDeepSeekChat({ apiKey: process.env.DEEPSEEK_API_KEY });
    resolvedLlmService = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: defaultPromptProvider,
      llmDebugStore
    });
  }

  const articleApi = createArticleApi({ articleStore });
  const questionApi = createQuestionApi({
    questionStore,
    llmDebugStore,
    articleStore,
    llmService: resolvedLlmService
  });
  const attemptApi = createAttemptApi({ attemptStore, scoreStore });
  const scoringApi = createScoringApi({
    attemptStore,
    scoreStore,
    llmDebugStore,
    questionStore,
    cardStore,
    llmService: resolvedLlmService
  });
  const cardsApi = createCardsApi({ questionStore, attemptStore, scoreStore, cardStore });
  const ttlDays = Number.parseInt(process.env.NOWCODER_ARTICLE_TTL_DAYS ?? "14", 10);
  const sourcesApi = createSourcesApi({
    nowCoderAdapter: nowCoder,
    articleStore,
    questionStore,
    crawlCursorStore,
    llmService: resolvedLlmService,
    ttlDays: Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 14
  });

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // --- Health -----------------------------------------------------------

    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "interview-training-workbench",
        llmConfigured: Boolean(resolvedLlmService)
      });
      return;
    }

    // --- Article routes ---------------------------------------------------

    if (url.pathname === "/api/articles/manual" && req.method === "POST") {
      await articleApi.handleCreateManual(req, res);
      return;
    }

    if (url.pathname === "/api/articles" && req.method === "GET") {
      await articleApi.handleList(req, res, url);
      return;
    }

    // --- Question routes --------------------------------------------------

    if (url.pathname === "/api/questions/import" && req.method === "POST") {
      await questionApi.handleImport(req, res);
      return;
    }

    if (url.pathname === "/api/questions/extract" && req.method === "POST") {
      await questionApi.handleExtract(req, res);
      return;
    }

    if (url.pathname === "/api/questions/purge-ignored" && req.method === "POST") {
      await questionApi.handlePurgeIgnored(req, res);
      return;
    }

    if (url.pathname === "/api/questions" && req.method === "GET") {
      await questionApi.handleList(req, res, url);
      return;
    }

    const questionUpdateMatch = url.pathname.match(/^\/api\/questions\/([A-Za-z0-9_-]+)$/);
    if (questionUpdateMatch && req.method === "PATCH") {
      await questionApi.handleUpdate(req, res, questionUpdateMatch[1]);
      return;
    }

    // --- Attempt routes ---------------------------------------------------

    if (url.pathname === "/api/attempts" && req.method === "POST") {
      await attemptApi.handleCreate(req, res);
      return;
    }

    if (url.pathname === "/api/attempts" && req.method === "GET") {
      await attemptApi.handleList(req, res, url);
      return;
    }

    const attemptScoreMatch = url.pathname.match(
      /^\/api\/attempts\/([A-Za-z0-9_-]+)\/score$/
    );
    if (attemptScoreMatch && req.method === "POST") {
      await scoringApi.handleScore(req, res, attemptScoreMatch[1]);
      return;
    }

    const attemptLlmScoreMatch = url.pathname.match(
      /^\/api\/attempts\/([A-Za-z0-9_-]+)\/llm-score$/
    );
    if (attemptLlmScoreMatch && req.method === "POST") {
      await scoringApi.handleLlmScore(req, res, attemptLlmScoreMatch[1]);
      return;
    }

    // --- Card routes ------------------------------------------------------

    if (url.pathname === "/api/cards/from-attempt" && req.method === "POST") {
      await cardsApi.handleFromAttempt(req, res);
      return;
    }

    if (url.pathname === "/api/cards" && req.method === "GET") {
      await cardsApi.handleList(req, res);
      return;
    }

    // --- Source routes ----------------------------------------------------

    if (url.pathname === "/api/sources/nowcoder/fetch" && req.method === "POST") {
      await sourcesApi.handleNowCoderFetch(req, res);
      return;
    }

    // --- Unknown API ------------------------------------------------------

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "API route not found", code: "API_NOT_FOUND" });
      return;
    }

    // --- Static fallback --------------------------------------------------

    const filePath = resolveStaticPath(url.pathname);
    if (!filePath) {
      sendJson(res, 403, { error: "Forbidden path", code: "PATH_FORBIDDEN" });
      return;
    }

    try {
      const body = await readFile(filePath);
      const type = contentTypes[extname(filePath)] ?? "application/octet-stream";
      res.writeHead(200, {
        "content-type": type,
        "cache-control": "no-store"
      });
      res.end(body);
    } catch (error) {
      if (error?.code === "ENOENT") {
        sendJson(res, 404, { error: "Not found", code: "NOT_FOUND" });
        return;
      }
      sendJson(res, 500, { error: "Static file read failed", code: "STATIC_READ_FAILED" });
    }
  });
}

export function startServer({ port = 8000, host = "127.0.0.1", baseDir = DEFAULT_BASE_DIR, nowCoderAdapter, llmService } = {}) {
  const server = createAppServer({ baseDir, nowCoderAdapter, llmService });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadLocalEnvFile();
  const port = Number.parseInt(process.env.PORT ?? "8000", 10);
  const host = process.env.HOST ?? "127.0.0.1";
  const baseDir = process.env.DATA_DIR ?? DEFAULT_BASE_DIR;
  const server = await startServer({ port, host, baseDir });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Interview training workbench listening on http://${host}:${actualPort}/ (data: ${baseDir})`);
}
