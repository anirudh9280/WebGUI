// Identity proofreading task: lanes, overlays, keys and side panel on top of the app core.
import {
  applyEvents, trackRuns, planAssign, describeEvent, trackName, uncertainLogRows, toCsv,
} from "./identity.js";
import { trackColor } from "../core/player.js";

const ACTION_COLOR = { swap: "#ce93d8", relabel: "#64b5f6", delete: "#ef5350", instance: "#ffb74d", uncertain: "#fff176" };
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function eventSpan(ev, nFrames) {
  return ev.kind === "instance" ? [ev.f, ev.f + 1] : [ev.f0, ev.f1 ?? nFrames];
}

function mergedLength(spans) {
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}

export function createIdentityTask(app) {
  const S = app.S;
  const name = (t) => trackName(S.labels.tracks, t);
  const actionOf = (ev) => (ev.kind === "map" ? ev.action ?? "relabel" : ev.kind);

  function recompute() {
    S.state = applyEvents(S.index, S.labels.events);
    S.runs = trackRuns(S.index, S.state);
  }

  function laneTracks() {
    const ids = new Set(S.labels.tracks.map((_, t) => t));
    for (const t of S.runs.keys()) ids.add(t);
    return [...ids].sort((a, b) => (a === -1) - (b === -1) || a - b);
  }

  function lanes() {
    return laneTracks().map((t) => ({
      track: t,
      label: t === -1 ? "· untracked" : `${t + 1}  ${name(t)}`,
      runs: S.runs.get(t) ?? [],
      selected: S.sel?.track === t,
    }));
  }

  function instancesAt(f) {
    const N = S.slp.nodes.length;
    const out = [];
    for (let k = S.index.frameStart[f]; k < S.index.frameStart[f + 1]; k++) {
      out.push({
        k, i: k - S.index.frameStart[f],
        pts: S.slp.points.subarray(k * N * 2, (k + 1) * N * 2),
        track: S.state.track[k], deleted: !!S.state.deleted[k],
        selected: S.sel?.k === k || (S.sel?.k == null && S.sel?.track === S.state.track[k] && !S.state.deleted[k]),
      });
    }
    return out;
  }

  function pick(inst) {
    S.sel = inst && !inst.deleted ? { track: inst.track, k: inst.k, f: S.frame } : null;
    app.refresh();
  }

  function lane(track) {
    S.sel = S.sel?.track === track && S.sel.k == null ? null : { track, k: null, f: S.frame };
    app.refresh();
  }

  const range = () => (S.range ? [S.range[0], S.range[1]] : [S.frame, null]);
  const selectedInstanceHere = () => (S.sel?.k != null && S.sel.f === S.frame ? S.sel.k : null);

  function add(ev, before) {
    const full = { id: newId(), created: new Date().toISOString(), note: "", ...ev };
    app.change((labels) => { before?.(labels); labels.events.push(full); }, { op: "add", event: full });
    app.toast(describeEvent(full, S.labels.tracks));
    return full;
  }

  function assign(dst, onlyThisFrame) {
    if (!S.sel) return app.toast("Select an animal first (click it, or click a lane name)");
    // digits past the known tracks create new ones (track_3, ...), in the same undo step
    const grow = (labels) => { while (labels.tracks.length <= dst) labels.tracks.push(`track_${labels.tracks.length}`); };
    if (onlyThisFrame) {
      const k = selectedInstanceHere();
      if (k == null) return app.toast("Alt+digit needs an animal selected in this frame");
      add({ kind: "instance", f: S.frame, i: k - S.index.frameStart[S.frame], dst }, grow);
    } else {
      const [f0, f1] = range();
      const ev = planAssign(S.index, S.state, { src: S.sel.track, dst, f0, f1 });
      if (!ev) return app.toast(`Already ${name(dst)}`);
      add(ev, grow);
    }
    S.sel = { ...S.sel, track: dst };
    app.refresh();
  }

  function del(wholeTrack) {
    if (!S.sel) return app.toast("Select an animal first");
    if (wholeTrack) {
      const [f0, f1] = range();
      add({ kind: "map", action: "delete", f0, f1, map: { [S.sel.track]: null } });
      S.sel = null;
    } else {
      const k = selectedInstanceHere();
      if (k == null) return app.toast("Delete needs an animal selected in this frame (Shift+Delete removes the track over a range)");
      add({ kind: "instance", f: S.frame, i: k - S.index.frameStart[S.frame], dst: null });
      S.sel = null;
    }
    app.refresh();
  }

  function uncertain() {
    const [f0, f1raw] = S.range ?? [S.frame, S.frame + 1];
    const f1 = f1raw ?? S.index.nFrames;
    const tracks = S.sel ? [S.sel.track] : laneTracks().filter((t) => (S.runs.get(t) ?? []).some(([a, b]) => a < f1 && b > f0));
    const note = prompt(`"Cannot tell" for frames ${f0}–${f1 - 1}. What happened?`, "");
    if (note === null) return;
    add({ kind: "uncertain", f0, f1, tracks, resolved: "unsure", note });
  }

  function markReviewed() {
    const [f0, f1] = S.range ?? app.timeline.visible();
    const minutes = (f1 - f0) / (S.video.fps || 50) / 60;
    if (!S.range && minutes > 1 && !confirm(`Mark all ${minutes.toFixed(1)} minutes on screen as reviewed?`)) return;
    const span = { f0, f1, at: new Date().toISOString() };
    app.change((labels) => labels.reviewed.push(span), { op: "reviewed", span });
    app.toast(`Reviewed frames ${f0}–${f1 - 1}`);
  }

  function jumpEvent(dir) {
    const starts = [...new Set(S.labels.events.map((e) => eventSpan(e, S.index.nFrames)[0]))].sort((a, b) => a - b);
    const f = dir > 0 ? starts.find((s) => s > S.frame) : starts.reverse().find((s) => s < S.frame);
    if (f != null) app.seek(f);
  }

  function key(ev) {
    const m = ev.code.match(/^(Digit|Numpad)([1-9])$/);
    if (m && !ev.metaKey && !ev.ctrlKey) { assign(Number(m[2]) - 1, ev.altKey); return true; }
    if ((ev.key === "Delete" || ev.key === "Backspace") && !ev.metaKey && !ev.ctrlKey) { del(ev.shiftKey); return true; }
    if (ev.code === "KeyU" && !ev.metaKey && !ev.ctrlKey) { uncertain(); return true; }
    if (ev.key === "Enter" && !ev.metaKey && !ev.ctrlKey) { markReviewed(); return true; }
    if (ev.code === "KeyN" && !ev.metaKey && !ev.ctrlKey) { jumpEvent(ev.shiftKey ? -1 : 1); return true; }
    return false;
  }

  function downloadText(filename, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function panel(el) {
    const n = S.index.nFrames;
    const events = S.labels.events
      .map((e, idx) => ({ e, idx, span: eventSpan(e, n) }))
      .sort((a, b) => a.span[0] - b.span[0] || a.idx - b.idx);
    const counts = {};
    for (const { e } of events) counts[actionOf(e)] = (counts[actionOf(e)] ?? 0) + 1;
    const reviewedPct = (100 * mergedLength(S.labels.reviewed.map((r) => [r.f0, r.f1]))) / n;
    const sel = S.sel
      ? `<div class="sel"><span style="color:${trackColor(S.sel.track)}">■</span> <b>${esc(name(S.sel.track))}</b>
         ${S.sel.k != null && S.sel.f === S.frame ? "(this instance)" : "(whole track)"}<br>
         <span class="muted">press 1–9 to assign, Delete to remove</span></div>`
      : `<div class="sel muted">Click an animal or a lane name to select it.</div>`;
    el.innerHTML = `
      <h3>Selection</h3>${sel}
      <div class="muted" style="margin-top:6px">Range: ${S.range ? `${S.range[0]}–${S.range[1] - 1}` : "from playhead to end"}</div>
      <h3>Progress</h3>
      <div class="stats">
        <span>reviewed</span><span>${reviewedPct.toFixed(1)}%</span>
        ${Object.entries(counts).map(([k, v]) => `<span style="color:${ACTION_COLOR[k]}">${k}</span><span>${v}</span>`).join("")}
        ${events.length ? "" : '<span class="muted">no fixes yet</span><span></span>'}
      </div>
      <h3>Events (${events.length})</h3>
      <ul class="events">${events.map(({ e, span }) => `
        <li data-id="${e.id}">
          <span class="dot" style="background:${ACTION_COLOR[actionOf(e)]}"></span>
          <span>${esc(describeEvent(e, S.labels.tracks))}
            ${e.kind === "uncertain" ? `<button class="resolved" data-resolve="${e.id}" title="click to change">${e.resolved}</button>` : ""}
            <br><span class="frames">${span[0]}–${span[1] - 1}${e.note ? ` · ${esc(e.note)}` : ""}</span></span>
          <button class="x" data-del="${e.id}" title="remove this event">✕</button>
        </li>`).join("")}</ul>
      <div class="panel-actions">
        <button id="dl-slp" title="Original .slp with your fixes applied (made on the server)">corrected .slp</button>
        <button id="dl-log" title="Leo's uncertain_log.csv columns">uncertain_log.csv</button>
        <button id="dl-json">labels .json</button>
        <button id="done" class="primary">${S.labels.done ? "Done ✓" : "Mark done"}</button>
      </div>`;
    el.querySelectorAll(".events li").forEach((li) => li.addEventListener("click", (evt) => {
      const id = li.dataset.id;
      const e = S.labels.events.find((x) => x.id === id);
      if (evt.target.dataset.del) {
        app.change((labels) => { labels.events = labels.events.filter((x) => x.id !== id); }, { op: "remove", id });
        return;
      }
      if (evt.target.dataset.resolve) {
        const next = { unsure: "yes", yes: "no", no: "unsure" }[e.resolved] ?? "unsure";
        app.change(() => { e.resolved = next; }, { op: "resolve", id, resolved: next });
        return;
      }
      const [a, b] = eventSpan(e, n);
      app.seek(a);
      if (e.kind !== "instance" && e.f1 != null) { S.range = [a, b]; app.refresh(); }
    }));
    el.querySelectorAll(".events li").forEach((li) => li.addEventListener("dblclick", () => {
      const e = S.labels.events.find((x) => x.id === li.dataset.id);
      const note = prompt("Note", e.note ?? "");
      if (note !== null) app.change(() => { e.note = note; }, { op: "note", id: e.id });
    }));
    // Exports come from the saved labels, so save first (deliberate: also logs a snapshot).
    const saved = async () => {
      await app.saveNow(true);
      if (S.dirty) app.toast("Couldn't save, so there is nothing to export yet");
      return !S.dirty;
    };
    const fromServer = async (what) => {
      if (!(await saved())) return;
      const a = document.createElement("a");
      a.href = S.store.exportUrl(S.labels, what);
      a.click();
    };
    el.querySelector("#dl-slp").onclick = async () => {
      if (S.store.exportsOnServer) return fromServer("corrected.slp");
      if (!(await saved())) return;
      // Folder mode has no Python: the .slp is written by the export tool (README "After labeling").
      const labelsFile = `${S.store.name}/${S.labels.dataset}/${S.labels.stem}/${S.labels.annotator}.json`;
      prompt("Your labels are saved. To build the corrected .slp, run this in Web_GUI/tools " +
        "(with your labels folder and the original .slp):",
        `uv run python -m webgui_tools.export "<path to>/${labelsFile}" "<path to>/${S.labels.source.slp_name}" ` +
        `"${S.labels.stem}.${S.labels.annotator}.corrected.slp"`);
    };
    el.querySelector("#dl-log").onclick = async () => {
      if (S.store.exportsOnServer) return fromServer("uncertain_log.csv");
      downloadText(`${S.labels.stem}_uncertain_log_${S.labels.annotator}.csv`,
        toCsv(uncertainLogRows(S.labels, S.labels.stem, n)), "text/csv");
    };
    el.querySelector("#dl-json").onclick = () =>
      downloadText(`${S.labels.stem}.${S.labels.annotator}.json`, JSON.stringify(S.labels, null, 1), "application/json");
    el.querySelector("#done").onclick = () => {
      app.change((labels) => { labels.done = !labels.done; }, { op: "done", snapshot: true });
      app.saveNow(true);
    };
  }

  return { recompute, lanes, instancesAt, pick, lane, key, panel };
}
