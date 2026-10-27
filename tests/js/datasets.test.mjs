import { test } from "node:test";
import assert from "node:assert/strict";
import { pairItems } from "../../js/core/datasets.js";

// Same cases as test_pair_items_prefers_tracked in tools/tests/test_server.py.
test("pairItems prefers .tracked.slp and sorts numerically", () => {
  const names = ["GT00.mp4", "GT00.predictions.slp", "GT00.tracked.slp", "ID10.mp4", "ID10.slp", "ID2.mp4", "ID2.slp", "lone.mp4", ".hidden.mp4", ".hidden.slp"];
  assert.deepEqual(pairItems(names).map((i) => [i.stem, i.slp]), [
    ["GT00", "GT00.tracked.slp"], ["ID2", "ID2.slp"], ["ID10", "ID10.slp"]]);
});
