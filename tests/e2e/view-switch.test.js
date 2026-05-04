import assert from "node:assert/strict";
import test from "node:test";
import { buildAppDom } from "../helpers/buildAppDom.js";

test("default state shows the home view and hides the practice view", async () => {
  const dom = await buildAppDom();
  const { document } = dom.window;

  const home = document.querySelector('[data-view="home"]');
  const practice = document.querySelector('[data-view="practice"]');

  assert.ok(home, "home view exists");
  assert.ok(practice, "practice view exists");
  assert.equal(home.hidden, false, "home view is visible by default");
  assert.equal(practice.hidden, true, "practice view starts hidden");
});

test("clicking a training card opens the practice view", async () => {
  const dom = await buildAppDom();
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
  const dom = await buildAppDom();
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
  const dom = await buildAppDom();
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
