import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startServer } from "../server.js";

async function withServer(run) {
  const server = await startServer({ port: 0 });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health check returns 200", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
  });
});

test("serves the app shell", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /题目库/);
    assert.match(body, /data-view="home"/);
    assert.match(body, /data-view="practice" hidden/);
  });
});

test("static files exist", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(html, /面经训练台/);
  assert.match(script, /function showView/);
  assert.match(styles, /\.screen\[hidden\]/);
});
