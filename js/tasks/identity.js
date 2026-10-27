// Identity proofreading: pure event model (no DOM). Mirrors tools/webgui_tools/identity.py;
// both are checked against tests/fixtures/identity_cases.json.
//
// An "index" is the instance table of a clip, flattened in source-file order:
//   { nFrames, frameStart: Int32Array(nFrames + 1), track: Int16Array(nInstances) }
// Instances of frame f are frameStart[f] .. frameStart[f+1]-1. Track -1 = untracked.

export const SCHEMA = "webgui-identity/1";

export function indexFromLists(frames) {
  const frameStart = new Int32Array(frames.length + 1);
  for (let f = 0; f < frames.length; f++) frameStart[f + 1] = frameStart[f] + frames[f].length;
  return { nFrames: frames.length, frameStart, track: Int16Array.from(frames.flat()) };
}

function frameRange(index, f0, f1) {
  const lo = Math.max(0, f0);
  const hi = Math.min(index.nFrames, f1 == null ? index.nFrames : f1);
  return [lo, hi];
}

// Apply events in order. Returns per-instance { track, deleted } (copies; index is untouched).
export function applyEvents(index, events) {
  const track = Int16Array.from(index.track);
  const deleted = new Uint8Array(track.length);
  for (const ev of events) {
    if (ev.kind === "map") {
      const m = new Map(Object.entries(ev.map).map(([k, v]) => [Number(k), v]));
      const [lo, hi] = frameRange(index, ev.f0, ev.f1);
      for (let k = index.frameStart[lo]; k < index.frameStart[hi]; k++) {
        if (deleted[k] || !m.has(track[k])) continue;
        const dst = m.get(track[k]);
        if (dst === null) deleted[k] = 1;
        else track[k] = dst;
      }
    } else if (ev.kind === "instance") {
      const k = index.frameStart[ev.f] + ev.i;
      if (ev.f < 0 || ev.f >= index.nFrames || k >= index.frameStart[ev.f + 1] || deleted[k]) continue;
      if (ev.dst === null) deleted[k] = 1;
      else track[k] = ev.dst;
    }
    // "uncertain" records a judgement only.
  }
  return { track, deleted };
}

// Map<track, [[f0, f1), ...]> of frames where each track has at least one live instance.
export function trackRuns(index, state) {
  const runs = new Map();
  const open = new Map();
  for (let f = 0; f <= index.nFrames; f++) {
    const here = new Set();
    if (f < index.nFrames) {
      for (let k = index.frameStart[f]; k < index.frameStart[f + 1]; k++) {
        if (!state.deleted[k]) here.add(state.track[k]);
      }
    }
    for (const [t, start] of open) {
      if (!here.has(t)) {
        if (!runs.has(t)) runs.set(t, []);
        runs.get(t).push([start, f]);
        open.delete(t);
      }
    }
    for (const t of here) if (!open.has(t)) open.set(t, f);
  }
  return runs;
}

function presentIn(index, state, t, f0, f1) {
  const [lo, hi] = frameRange(index, f0, f1);
  for (let k = index.frameStart[lo]; k < index.frameStart[hi]; k++) {
    if (!state.deleted[k] && state.track[k] === t) return true;
  }
  return false;
}

// "Make src be dst on [f0, f1)": swap if dst is already there, else relabel. null if no-op.
export function planAssign(index, state, { src, dst, f0, f1 }) {
  if (src === dst) return null;
  const swap = presentIn(index, state, dst, f0, f1);
  return {
    kind: "map",
    action: swap ? "swap" : "relabel",
    f0,
    f1: f1 ?? null,
    map: swap ? { [src]: dst, [dst]: src } : { [src]: dst },
  };
}

export function trackName(tracks, t) {
  if (t === -1) return "untracked";
  return tracks[t] ?? `track_${t}`;
}

export function describeEvent(ev, tracks) {
  const name = (t) => trackName(tracks, t);
  if (ev.kind === "map") {
    const pairs = Object.entries(ev.map).map(([k, v]) => [Number(k), v]);
    if (ev.action === "swap" && pairs.length === 2) return `swap ${name(pairs[0][0])}<->${name(pairs[0][1])}`;
    return pairs
      .map(([s, d]) => (d === null ? `delete ${name(s)}` : `relabel ${name(s)}->${name(d)}`))
      .join("; ");
  }
  if (ev.kind === "instance") {
    return ev.dst === null ? `delete instance ${ev.i}` : `instance ${ev.i} -> ${name(ev.dst)}`;
  }
  return `cannot tell ${ev.tracks.map(name).join(", ")}`;
}

// Rows for Leo's uncertain_log.csv (frame_end inclusive). One row per event.
export function uncertainLogRows(labels, clipId, nFrames) {
  const rows = [["clip_id", "frame_start", "frame_end", "what_happened", "resolved"]];
  for (const ev of labels.events) {
    const [f0, f1] = ev.kind === "instance" ? [ev.f, ev.f + 1] : [ev.f0, ev.f1 ?? nFrames];
    const what = describeEvent(ev, labels.tracks) + (ev.note ? `: ${ev.note}` : "");
    rows.push([clipId, f0, Math.min(f1, nFrames) - 1, what, ev.kind === "uncertain" ? ev.resolved : "yes"]);
  }
  return rows;
}

export function toCsv(rows) {
  const cell = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

export function emptyLabels({ dataset, stem, annotator, tracks, source }) {
  return { schema: SCHEMA, dataset, stem, annotator, updated: null, source, tracks, events: [], reviewed: [] };
}
