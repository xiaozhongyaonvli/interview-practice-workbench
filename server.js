import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(rootDir, "public");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function resolveStaticPath(pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    return null;
  }

  return filePath;
}

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "interview-training-workbench" });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "API is not implemented in Step 0" });
      return;
    }

    const filePath = resolveStaticPath(url.pathname);
    if (!filePath) {
      sendJson(res, 403, { error: "Forbidden path" });
      return;
    }

    try {
      const body = await readFile(filePath);
      const type = contentTypes[extname(filePath)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type });
      res.end(body);
    } catch (error) {
      if (error?.code === "ENOENT") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      sendJson(res, 500, { error: "Static file read failed" });
    }
  });
}

export function startServer({ port = 8000, host = "127.0.0.1" } = {}) {
  const server = createAppServer();

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
  const server = await startServer({ port, host });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Interview training workbench listening on http://${host}:${actualPort}/`);
}
