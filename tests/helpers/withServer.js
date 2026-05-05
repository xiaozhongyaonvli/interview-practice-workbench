// Test helper: spin up the HTTP server on a random port, hand its base URL
// to the caller, then close it cleanly.
//
// baseDir is optional. When omitted, callers should not exercise routes that
// touch storage — they will write into the project's real data/ directory.
// API tests should always pass a fresh tmp dir.
//
// nowCoderAdapter is optional. If provided, the server will use it instead
// of the default adapter (which uses Node's global fetch). Tests that
// exercise the nowcoder routes should pass a mock adapter.

import { startServer } from "../../server.js";

export async function withServer(run, options = {}) {
  const server = await startServer({ port: 0, host: "127.0.0.1", ...options });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
