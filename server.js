import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createArticleStore } from "./src/storage/articleStore.js";
import { createQuestionStore } from "./src/storage/questionStore.js";
import { createLlmDebugStore } from "./src/storage/llmDebugStore.js";
import { createArticleApi } from "./src/api/articles.js";
import { createQuestionApi } from "./src/api/questions.js";
import { sendJson } from "./src/api/http.js";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(rootDir, "public");
const DEFAULT_BASE_DIR = join(rootDir, "data");

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
export function createAppServer({ baseDir = DEFAULT_BASE_DIR } = {}) {
  const articleStore = createArticleStore({ baseDir });
  const questionStore = createQuestionStore({ baseDir });
  const llmDebugStore = createLlmDebugStore({ baseDir });
  const articleApi = createArticleApi({ articleStore });
  const questionApi = createQuestionApi({ questionStore, llmDebugStore });

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // --- Health -----------------------------------------------------------

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "interview-training-workbench" });
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

    if (url.pathname === "/api/questions" && req.method === "GET") {
      await questionApi.handleList(req, res, url);
      return;
    }

    const questionUpdateMatch = url.pathname.match(/^\/api\/questions\/([A-Za-z0-9_-]+)$/);
    if (questionUpdateMatch && req.method === "PATCH") {
      await questionApi.handleUpdate(req, res, questionUpdateMatch[1]);
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
      res.writeHead(200, { "content-type": type });
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

export function startServer({ port = 8000, host = "127.0.0.1", baseDir = DEFAULT_BASE_DIR } = {}) {
  const server = createAppServer({ baseDir });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? "8000", 10);
  const host = process.env.HOST ?? "127.0.0.1";
  const baseDir = process.env.DATA_DIR ?? DEFAULT_BASE_DIR;
  const server = await startServer({ port, host, baseDir });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Interview training workbench listening on http://${host}:${actualPort}/ (data: ${baseDir})`);
}
