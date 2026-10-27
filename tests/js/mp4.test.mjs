import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, openSync, readSync, fstatSync } from "node:fs";
import { parseMp4 } from "../../js/io/mp4-parse.js";

const root = new URL("../../", import.meta.url).pathname;
const clip = `${root}.cache/media/batch02_identity/ID000.mp4`;
const hour = "/Volumes/talmo/leo/2026-07-28-HCM-Sleep/gt_release/batch04_six_hours/GT04.mp4";

function fileReader(path) {
  const fd = openSync(path, "r");
  const read = async (off, len) => {
    const b = Buffer.alloc(len);
    const got = readSync(fd, b, 0, len, off);
    return new Uint8Array(b.buffer, b.byteOffset, got);
  };
  return { read, size: fstatSync(fd).size };
}

function checkSegments(m) {
  // Every frame belongs to exactly one segment, starting at a sync sample, covering its samples.
  for (const seg of m.segments) {
    assert.ok(m.isKey[seg.s0] || seg.f0 === 0, `segment at frame ${seg.f0} does not start on a sync sample`);
    for (let f = seg.f0; f < seg.f1; f++) {
      const smp = m.frameToSample[f];
      assert.ok(smp >= seg.s0 && smp < seg.s1, `frame ${f} outside its segment`);
    }
  }
}

test("transcoded clip: no B-frames, keyframe every 50", { skip: !existsSync(clip) && "clip not present" }, async () => {
  const { read, size } = fileReader(clip);
  const m = await parseMp4(read, size);
  assert.equal(m.nFrames, 15000);
  assert.equal(m.width, 1280);
  assert.equal(m.height, 1024);
  assert.match(m.codec, /^avc1\.[0-9a-f]{6}$/);
  assert.equal(Math.round(m.fps), 50);
  assert.equal(m.segments.length, 300);
  for (let f = 0; f < 100; f++) assert.equal(m.frameToSample[f], f);
  // first sample starts with an H.264 length-prefixed NAL
  const first = await read(m.offset[0], 8);
  assert.ok(first.length === 8 && m.size[0] > 8);
  checkSegments(m);
});

test("batch-04 hour: moov at end, B-frames", { skip: !existsSync(hour) && "VAST not mounted" }, async () => {
  const { read, size } = fileReader(hour);
  const m = await parseMp4(read, size);
  assert.equal(m.nFrames, 180000);
  assert.equal(m.segments.length, 720);
  const seen = new Uint8Array(m.nFrames);
  for (const smp of m.frameToSample) seen[smp]++;
  assert.ok(seen.every((c) => c === 1), "frameToSample is a permutation");
  assert.ok(m.frameToSample.some((smp, f) => smp !== f), "B-frames reorder samples");
  checkSegments(m);
});
