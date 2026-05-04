// Test helper: bootstrap a jsdom that loads public/index.html with public/app.js
// inlined, while ensuring the script runs against an already-stubbed fetch
// implementation.
//
// Why beforeParse: jsdom executes the inlined script synchronously while the
// JSDOM constructor returns, so any window.fetch assignment performed AFTER
// the constructor is too late — the script's startup code (e.g.
// refreshImportedList) has already called fetch and failed. beforeParse runs
// before HTML parsing, so we can install the stub on window first.

import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

function defaultFetchStub() {
  // Returns an empty article list on any request. Suitable for tests that do
  // not care about the API and just want the DOM to settle quietly.
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ articles: [] }),
    text: () => Promise.resolve("")
  });
}

/**
 * Build the app DOM with the given fetch stub already wired in.
 *
 * @param {object}   options
 * @param {Function} options.fetch  Function used as window.fetch.
 *                                  Default: returns { articles: [] } on any request.
 * @returns {Promise<import("jsdom").JSDOM>}
 */
export async function buildAppDom({ fetch: fetchHandler = defaultFetchStub } = {}) {
  const htmlUrl = new URL("../../public/index.html", import.meta.url);
  const scriptUrl = new URL("../../public/app.js", import.meta.url);
  const [html, script] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(scriptUrl, "utf8")
  ]);

  // Replace <script defer src="/app.js"> with an inline copy at the end of
  // the body so the script can see a fully-parsed document.
  const inlined = html
    .replace(/<script\s+defer\s+src="\/app\.js"\s*><\/script>/, "")
    .replace("</body>", `<script>${script}</script></body>`);

  const dom = new JSDOM(inlined, {
    runScripts: "dangerously",
    url: "http://127.0.0.1/",
    beforeParse(window) {
      // jsdom does not implement smooth scroll; suppress the warning.
      window.scrollTo = () => {};
      window.fetch = fetchHandler;
    }
  });

  // Drain microtasks + one macrotask so the initial refreshImportedList()
  // promise resolves before the test inspects the DOM.
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  }

  return dom;
}

/** Drain a few iterations of microtask + setTimeout so async chains settle. */
export async function flushDom(dom, ticks = 5) {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  }
}
