import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../src/util/mapWithConcurrency.js";

test("mapWithConcurrency preserves order and caps in-flight work", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.equal(maxInFlight, 2);
});
