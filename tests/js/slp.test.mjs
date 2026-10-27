// Checks js/io/slp-parse.js against tools/webgui_tools/slp.py on a real clip.
// Needs .cache/media/batch02_identity/ID000.slp and .cache/ID000.index.json; see README "Tests".
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const slpPath = `${root}.cache/media/batch02_identity/ID000.slp`;
const refPath = `${root}.cache/ID000.index.json`;
const have = existsSync(slpPath) && existsSync(refPath);

test("parseSlp matches the Python index on ID000", { skip: !have && "real-data fixtures not present" }, async () => {
  const h5 = await import("../../vendor/h5wasm/hdf5_hl.js");
  await h5.ready;
  const { parseSlp } = await import("../../js/io/slp-parse.js");
  h5.FS.writeFile("/ID000.slp", readFileSync(slpPath));
  const file = new h5.File("/ID000.slp", "r");
  const s = parseSlp(h5, file);
  file.close();
  const ref = JSON.parse(readFileSync(refPath, "utf8"));
  assert.equal(s.nFrames, ref.nFrames);
  assert.deepEqual(s.tracks, ref.tracks);
  assert.deepEqual([...s.frameStart], ref.frameStart);
  assert.deepEqual([...s.track], ref.track);
  assert.equal(s.nodes.length, 15);
  assert.equal(s.points.length, s.nInstances * 15 * 2);
  assert.ok(s.edges.every(([a, b]) => a >= 0 && a < 15 && b >= 0 && b < 15));
});
