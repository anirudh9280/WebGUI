import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  indexFromLists, applyEvents, trackRuns, planAssign, uncertainLogRows, toCsv,
} from "../../js/tasks/identity.js";

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/identity_cases.json", import.meta.url)),
);

function finalLists(index, state) {
  const out = [];
  for (let f = 0; f < index.nFrames; f++) {
    const row = [];
    for (let k = index.frameStart[f]; k < index.frameStart[f + 1]; k++) {
      row.push(state.deleted[k] ? null : state.track[k]);
    }
    out.push(row);
  }
  return out;
}

for (const c of fixtures.cases) {
  test(`fixture: ${c.name}`, () => {
    const index = indexFromLists(c.frames);
    const state = applyEvents(index, c.events);
    assert.deepEqual(finalLists(index, state), c.expected);
  });
}

test("applyEvents does not mutate the index", () => {
  const index = indexFromLists([[0, 1]]);
  applyEvents(index, [{ kind: "map", f0: 0, f1: null, map: { 0: 1, 1: 0 } }]);
  assert.deepEqual([...index.track], [0, 1]);
});

test("trackRuns gives half-open presence runs per track", () => {
  const index = indexFromLists([[0], [0, 1], [1], [0, 1], []]);
  const runs = trackRuns(index, applyEvents(index, []));
  assert.deepEqual(runs.get(0), [[0, 2], [3, 4]]);
  assert.deepEqual(runs.get(1), [[1, 4]]);
});

test("planAssign: target absent in range -> relabel", () => {
  const index = indexFromLists([[0, 1], [0, 1], [0, 1]]);
  const state = applyEvents(index, []);
  const ev = planAssign(index, state, { src: 1, dst: 2, f0: 1, f1: null });
  assert.equal(ev.kind, "map");
  assert.equal(ev.action, "relabel");
  assert.deepEqual(ev.map, { 1: 2 });
  assert.equal(ev.f0, 1);
});

test("planAssign: target present in range -> swap", () => {
  const index = indexFromLists([[0, 1], [0, 1]]);
  const state = applyEvents(index, []);
  const ev = planAssign(index, state, { src: 1, dst: 0, f0: 0, f1: 1 });
  assert.equal(ev.action, "swap");
  assert.deepEqual(ev.map, { 1: 0, 0: 1 });
});

test("planAssign: src == dst is a no-op", () => {
  const index = indexFromLists([[0, 1]]);
  assert.equal(planAssign(index, applyEvents(index, []), { src: 0, dst: 0, f0: 0, f1: null }), null);
});

test("uncertain log rows follow Leo's columns", () => {
  const labels = {
    tracks: ["mouse_2", "mouse_0"],
    events: [
      { kind: "map", action: "swap", f0: 10, f1: null, map: { 0: 1, 1: 0 }, note: "" },
      { kind: "uncertain", f0: 20, f1: 31, tracks: [0, 1], resolved: "unsure", note: "huddle" },
      { kind: "instance", f: 5, i: 1, dst: null, note: "" },
    ],
  };
  const rows = uncertainLogRows(labels, "ID000", 15000);
  assert.deepEqual(rows[0], ["clip_id", "frame_start", "frame_end", "what_happened", "resolved"]);
  assert.deepEqual(rows[1], ["ID000", 10, 14999, "swap mouse_2<->mouse_0", "yes"]);
  assert.deepEqual(rows[2], ["ID000", 20, 30, "cannot tell mouse_2, mouse_0: huddle", "unsure"]);
  assert.deepEqual(rows[3], ["ID000", 5, 5, "delete instance 1", "yes"]);
  assert.equal(toCsv([["a", "x,y"], [1, 'q"']]), 'a,"x,y"\n1,"q"""\n');
});
