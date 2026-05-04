import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../../server.js";

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

test("app shell exposes the topic-library to practice-detail flow", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /id="home" class="screen active-view"/);
    assert.match(body, /id="practice" class="screen" data-view="practice" hidden/);
    assert.match(body, /data-open-practice/);
    assert.match(body, /data-back-home/);
  });
});
