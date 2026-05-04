import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

// Build a fresh DOM for each test by inlining public/app.js into public/index.html.
// We do not start the HTTP server because Step 0 e2e only verifies browser-side
// view switching, which is decoupled from server.js by design.
//
// app.js is injected just before </body> rather than in <head>: the original page
// uses <script defer>, which the browser runs after DOM parsing. jsdom's
// runScripts: "dangerously" executes inline scripts synchronously where they
// appear, so a head-injected copy would query an empty body and bind no events.
async function buildDom() {
  const htmlUrl = new URL("../../public/index.html", import.meta.url);
  const scriptUrl = new URL("../../public/app.js", import.meta.url);

  const [html, script] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(scriptUrl, "utf8")
  ]);

  const inlined = html
    .replace(/<script\s+defer\s+src="\/app\.js"\s*><\/script>/, "")
    .replace("</body>", `<script>${script}</script></body>`);

  const dom = new JSDOM(inlined, { runScripts: "dangerously" });

  // jsdom does not implement smooth scroll; suppress "Not implemented" noise.
  dom.window.scrollTo = () => {};

  return dom;
}

test("default state shows the home view and hides the practice view", async () => {
  const dom = await buildDom();
  const { document } = dom.window;

  const home = document.querySelector('[data-view="home"]');
  const practice = document.querySelector('[data-view="practice"]');

  assert.ok(home, "home view exists");
  assert.ok(practice, "practice view exists");
  assert.equal(home.hidden, false, "home view is visible by default");
  assert.equal(practice.hidden, true, "practice view starts hidden");
});

test("clicking a training card opens the practice view", async () => {
  const dom = await buildDom();
  const { document } = dom.window;

  const enterButton = document.querySelector("[data-open-practice]");
  assert.ok(enterButton, "at least one training card exposes a practice entry");

  enterButton.click();

  const home = document.querySelector('[data-view="home"]');
  const practice = document.querySelector('[data-view="practice"]');

  assert.equal(practice.hidden, false, "practice view becomes visible after click");
  assert.equal(home.hidden, true, "home view becomes hidden after click");
});

test("clicking back-home from the practice view restores the home view", async () => {
  const dom = await buildDom();
  const { document } = dom.window;

  // First navigate into the practice view.
  document.querySelector("[data-open-practice]").click();

  const backButton = document.querySelector("[data-back-home]");
  assert.ok(backButton, "practice view exposes a back-home control");

  backButton.click();

  const home = document.querySelector('[data-view="home"]');
  const practice = document.querySelector('[data-view="practice"]');

  assert.equal(home.hidden, false, "home view is shown again");
  assert.equal(practice.hidden, true, "practice view is hidden again");
});

test("top-nav links toggle between home and practice views", async () => {
  // Top-nav <a> entries also drive showView; covering this prevents regressions
  // when later steps add per-view nav state.
  const dom = await buildDom();
  const { document } = dom.window;

  const practiceLink = document.querySelector('[data-view-link="practice"]');
  const homeLink = document.querySelector('[data-view-link="home"]');
  assert.ok(practiceLink && homeLink, "top-nav exposes practice and home links");

  practiceLink.click();
  assert.equal(
    document.querySelector('[data-view="practice"]').hidden,
    false,
    "practice link reveals practice view"
  );
  assert.equal(
    practiceLink.classList.contains("active"),
    true,
    "practice link is marked active"
  );

  homeLink.click();
  assert.equal(
    document.querySelector('[data-view="home"]').hidden,
    false,
    "home link restores home view"
  );
  assert.equal(
    homeLink.classList.contains("active"),
    true,
    "home link is marked active again"
  );
});
