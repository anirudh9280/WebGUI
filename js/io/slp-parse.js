// Read a SLEAP .slp (HDF5) into flat typed arrays. Runs in a worker (slp.worker.js) and in
// node tests. Mirrors tools/webgui_tools/slp.py read_index: frames of video 0 sorted by
// frame_idx, instances in file order within a frame, empty frames filled in.

// Raw bytes of a whole dataset (h5wasm's .value unpacks compound rows one by one, too slow).
function readRaw(h5, file, path) {
  const ds = file.get(path);
  const meta = ds.metadata;
  const n = meta.shape.reduce((a, b) => a * b, 1);
  const nbytes = meta.size * n;
  if (nbytes === 0) return { meta, bytes: new Uint8Array(0), n: 0 };
  const M = h5.Module;
  const ptr = M._malloc(nbytes);
  try {
    M.get_dataset_data(file.file_id, ds.path, null, null, null, BigInt(ptr));
    return { meta, bytes: M.HEAPU8.slice(ptr, ptr + nbytes), n };
  } finally {
    M._free(ptr);
  }
}

// Column accessors for a compound table: col("name") -> (row) => number.
function columns({ meta, bytes }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stride = meta.size;
  const members = Object.fromEntries(meta.compound_type.members.map((m) => [m.name, m]));
  return (name) => {
    const m = members[name];
    if (!m) throw new Error(`missing column ${name}`);
    const o = m.offset;
    const le = m.littleEndian ?? true;
    if (m.type === 1) { // float
      return m.size === 8 ? (r) => view.getFloat64(r * stride + o, le) : (r) => view.getFloat32(r * stride + o, le);
    }
    switch (m.size) { // integers / bools
      case 1: return m.signed ? (r) => view.getInt8(r * stride + o) : (r) => view.getUint8(r * stride + o);
      case 2: return m.signed ? (r) => view.getInt16(r * stride + o, le) : (r) => view.getUint16(r * stride + o, le);
      case 4: return m.signed ? (r) => view.getInt32(r * stride + o, le) : (r) => view.getUint32(r * stride + o, le);
      case 8: return m.signed
        ? (r) => Number(view.getBigInt64(r * stride + o, le))
        : (r) => Number(view.getBigUint64(r * stride + o, le));
      default: throw new Error(`unsupported member size ${m.size} for ${name}`);
    }
  };
}

function readStrings(file, path) {
  const v = file.get(path).value;
  return Array.from(v, (s) => (typeof s === "string" ? s : new TextDecoder().decode(s)));
}

export function parseSlp(h5, file) {
  const metaJson = JSON.parse(file.get("metadata").attrs.json.value);
  const nodes = metaJson.nodes.map((n) => n.name);
  const sk = metaJson.skeletons?.[0];
  const idToNode = new Map((sk?.nodes ?? []).map((n, k) => [n.id, typeof n.id === "number" ? n.id : k]));
  const edges = (sk?.links ?? []).map((l) => [idToNode.get(l.source) ?? l.source, idToNode.get(l.target) ?? l.target]);

  const tracks = readStrings(file, "tracks_json").map((s) => JSON.parse(s)[1]);
  const video = JSON.parse(readStrings(file, "videos_json")[0]);
  const shape = video.backend?.shape;
  const fps = video.backend?.fps ?? 0;

  const fr = readRaw(h5, file, "frames");
  const fcol = columns(fr);
  const [fVideo, fIdx, fA, fB] = ["video", "frame_idx", "instance_id_start", "instance_id_end"].map(fcol);
  const order = [];
  let maxFrame = -1;
  for (let r = 0; r < fr.n; r++) {
    if (fVideo(r) !== 0) continue;
    order.push(r);
    maxFrame = Math.max(maxFrame, fIdx(r));
  }
  order.sort((a, b) => fIdx(a) - fIdx(b) || a - b);
  const nFrames = shape ? shape[0] : maxFrame + 1;

  const ins = readRaw(h5, file, "instances");
  const icol = columns(ins);
  const [iType, iTrack, iP0, iP1] = ["instance_type", "track", "point_id_start", "point_id_end"].map(icol);
  const pts = { 1: readRaw(h5, file, "pred_points"), 0: readRaw(h5, file, "points") };
  const pcol = { 1: pts[1].n ? columns(pts[1]) : null, 0: pts[0].n ? columns(pts[0]) : null };
  const px = {}, py = {}, pv = {};
  for (const t of [0, 1]) if (pcol[t]) [px[t], py[t], pv[t]] = ["x", "y", "visible"].map(pcol[t]);

  const counts = new Int32Array(nFrames);
  for (const r of order) counts[fIdx(r)] += fB(r) - fA(r);
  const frameStart = new Int32Array(nFrames + 1);
  for (let f = 0; f < nFrames; f++) frameStart[f + 1] = frameStart[f] + counts[f];
  const nInst = frameStart[nFrames];
  const nNodes = nodes.length;
  const track = new Int16Array(nInst);
  const points = new Float32Array(nInst * nNodes * 2).fill(NaN);
  let k = 0;
  for (const r of order) {
    for (let row = fA(r); row < fB(r); row++, k++) {
      track[k] = iTrack(row);
      const t = iType(row) === 1 ? 1 : 0;
      const p0 = iP0(row), p1 = iP1(row);
      for (let n = 0; n < Math.min(nNodes, p1 - p0); n++) {
        if (!pv[t](p0 + n)) continue;
        points[(k * nNodes + n) * 2] = px[t](p0 + n);
        points[(k * nNodes + n) * 2 + 1] = py[t](p0 + n);
      }
    }
  }
  return {
    nFrames, fps, tracks, nodes, edges,
    width: shape?.[2] ?? null, height: shape?.[1] ?? null,
    frameStart, track, points, nInstances: nInst,
  };
}
