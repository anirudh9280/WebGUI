// Minimal MP4 demuxer: the first video track's sample table, in a form that makes
// frame-exact seeking easy. Pure (no DOM); `read(offset, length) -> Promise<Uint8Array>`.
//
// Frame index f = rank of a sample in presentation (composition-time) order, so it matches
// what OpenCV/ffmpeg/SLEAP call frame f even when the file has B-frames (ctts).

async function readBoxHeader(read, pos) {
  const h = await read(pos, 16);
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  let size = v.getUint32(0);
  const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
  let hdr = 8;
  if (size === 1) { size = Number(v.getBigUint64(8)); hdr = 16; }
  return { size, type, hdr };
}

// Child boxes of a buffer region: [{type, start, end}] with start = payload start.
function children(buf, start, end) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = v.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let hdr = 8;
    if (size === 1) { size = Number(v.getBigUint64(pos + 8)); hdr = 16; }
    if (size === 0) size = end - pos;
    if (size < hdr) break;
    out.push({ type, start: pos + hdr, end: pos + size });
    pos += size;
  }
  return out;
}

const find = (buf, box, type) => children(buf, box.start, box.end).find((b) => b.type === type);

function hex2(n) { return n.toString(16).padStart(2, "0"); }

function parseStsd(buf, stsd) {
  // full box: version/flags(4) + entry_count(4), then sample entries
  const entry = children(buf, stsd.start + 8, stsd.end)[0];
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = v.getUint16(entry.start + 24);
  const height = v.getUint16(entry.start + 26);
  const sub = children(buf, entry.start + 78, entry.end);
  const cfg = sub.find((b) => b.type === "avcC" || b.type === "hvcC");
  let codec = entry.type;
  let description = null;
  if (cfg) {
    description = buf.slice(cfg.start, cfg.end);
    if (cfg.type === "avcC") codec = `${entry.type}.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`;
  }
  return { codec, description, width, height, entryType: entry.type };
}

export async function parseMp4(read, fileSize) {
  // Locate moov among top-level boxes (it may follow mdat).
  let pos = 0;
  let moovAt = null;
  while (pos < fileSize) {
    const { size, type } = await readBoxHeader(read, pos);
    if (type === "moov") { moovAt = { pos, size }; break; }
    if (size <= 0) break;
    pos += size;
  }
  if (!moovAt) throw new Error("no moov box (not an MP4, or truncated)");
  const buf = await read(moovAt.pos, moovAt.size);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const moov = { start: 8, end: buf.length };

  const trak = children(buf, moov.start, moov.end)
    .filter((b) => b.type === "trak")
    .find((t) => {
      const hdlr = find(buf, find(buf, t, "mdia"), "hdlr");
      return String.fromCharCode(...buf.slice(hdlr.start + 8, hdlr.start + 12)) === "vide";
    });
  if (!trak) throw new Error("no video track");
  const mdia = find(buf, trak, "mdia");
  const mdhd = find(buf, mdia, "mdhd");
  const timescale = buf[mdhd.start] === 1 ? v.getUint32(mdhd.start + 20) : v.getUint32(mdhd.start + 12);
  const stbl = find(buf, find(buf, mdia, "minf"), "stbl");
  const box = (t) => find(buf, stbl, t);
  const stsd = parseStsd(buf, box("stsd"));

  const stsz = box("stsz");
  const fixedSize = v.getUint32(stsz.start + 4);
  const n = v.getUint32(stsz.start + 8);
  const size = new Uint32Array(n);
  for (let i = 0; i < n; i++) size[i] = fixedSize || v.getUint32(stsz.start + 12 + 4 * i);

  const stco = box("stco") ?? box("co64");
  const nChunks = v.getUint32(stco.start + 4);
  const chunkOff = new Float64Array(nChunks);
  for (let c = 0; c < nChunks; c++) {
    chunkOff[c] = stco.type === "stco"
      ? v.getUint32(stco.start + 8 + 4 * c)
      : Number(v.getBigUint64(stco.start + 8 + 8 * c));
  }
  const stsc = box("stsc");
  const nStsc = v.getUint32(stsc.start + 4);
  const offset = new Float64Array(n);
  let s = 0;
  for (let e = 0; e < nStsc; e++) {
    const first = v.getUint32(stsc.start + 8 + 12 * e) - 1;
    const per = v.getUint32(stsc.start + 12 + 12 * e);
    const last = e + 1 < nStsc ? v.getUint32(stsc.start + 8 + 12 * (e + 1)) - 1 : nChunks;
    for (let c = first; c < last && s < n; c++) {
      let o = chunkOff[c];
      for (let k = 0; k < per && s < n; k++, s++) { offset[s] = o; o += size[s]; }
    }
  }

  const dts = new Float64Array(n);
  const stts = box("stts");
  let t = 0;
  s = 0;
  for (let e = 0, ne = v.getUint32(stts.start + 4); e < ne; e++) {
    const count = v.getUint32(stts.start + 8 + 8 * e);
    const delta = v.getUint32(stts.start + 12 + 8 * e);
    for (let k = 0; k < count && s < n; k++, s++) { dts[s] = t; t += delta; }
  }
  const cts = Float64Array.from(dts);
  const ctts = box("ctts");
  if (ctts) {
    const signed = buf[ctts.start] === 1;
    s = 0;
    for (let e = 0, ne = v.getUint32(ctts.start + 4); e < ne; e++) {
      const count = v.getUint32(ctts.start + 8 + 8 * e);
      const off = signed ? v.getInt32(ctts.start + 12 + 8 * e) : v.getUint32(ctts.start + 12 + 8 * e);
      for (let k = 0; k < count && s < n; k++, s++) cts[s] += off;
    }
  }
  const isKey = new Uint8Array(n);
  const stss = box("stss");
  if (stss) {
    for (let e = 0, ne = v.getUint32(stss.start + 4); e < ne; e++) isKey[v.getUint32(stss.start + 8 + 4 * e) - 1] = 1;
  } else {
    isKey.fill(1); // no stss: every sample is a sync sample
  }

  const frameToSample = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => cts[a] - cts[b]);
  const sampleToFrame = new Uint32Array(n);
  frameToSample.forEach((smp, f) => { sampleToFrame[smp] = f; });

  // Decode segments: from each sync sample (in presentation order) through every sample that is
  // presented before the next sync frame. segOfFrame[f] -> segment index.
  const syncFrames = [];
  for (let f = 0; f < n; f++) if (isKey[frameToSample[f]]) syncFrames.push(f);
  if (!syncFrames.length || syncFrames[0] !== 0) syncFrames.unshift(0);
  const segments = [];
  const segOfFrame = new Uint32Array(n);
  for (let g = 0; g < syncFrames.length; g++) {
    const f0 = syncFrames[g];
    const f1 = g + 1 < syncFrames.length ? syncFrames[g + 1] : n;
    let sLast = 0;
    for (let f = f0; f < f1; f++) { segOfFrame[f] = g; sLast = Math.max(sLast, frameToSample[f]); }
    segments.push({ f0, f1, s0: frameToSample[f0], s1: sLast + 1 });
  }

  const durationTicks = n ? (dts[n - 1] - dts[0]) + (n > 1 ? dts[1] - dts[0] : 0) : 0;
  return {
    nFrames: n, timescale, fps: durationTicks ? (n * timescale) / durationTicks : 0,
    ...stsd, offset, size, isKey, cts, frameToSample, sampleToFrame, segments, segOfFrame,
  };
}
