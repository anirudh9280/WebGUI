// App core: choose clips, open one, play/seek, undo, autosave. Two modes, picked automatically:
//  - folder mode (GitHub Pages, no server): the user picks a data folder and a labels folder on
//    their mounted VAST share; everything runs in the browser (Chrome/Edge);
//  - server mode: served by tools/webgui_tools/server.py, which lists datasets and stores labels.
// Task-specific behaviour (lanes, keys, side panel) lives in js/tasks/*-ui.js.
//
// URL: #item=<stem>&f=<frame> reopens a clip at a frame (plus ?dataset=<name> in server mode).

import { datasetFromHandle, openServerDataset, serverDatasets } from "./datasets.js";
import { ConflictError, FolderStore, ServerStore, recallHandle, rememberHandle, safeName } from "./labels.js";
import { Player } from "./player.js";
import { Timeline } from "./timeline.js";
import { VideoReader, sha1Hex } from "../io/video.js";
import { loadSlp } from "../io/slp.js";
import { createIdentityTask } from "../tasks/identity-ui.js";
import { emptyLabels } from "../tasks/identity.js";

const $ = (sel) => document.querySelector(sel);
const AUTOSAVE_MS = 1200;
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const getPref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

const S = {
  annotator: getPref("webgui.annotator") ?? "",
  mode: null, dataset: null, store: null, item: null,
  video: null, slp: null, index: null, labels: null, state: null, runs: null,
  frame: 0, playing: false, speed: 1,
  sel: null, range: null,
  undo: [], redo: [], dirty: false, pendingLog: [], saveTimer: null, saving: null,
  showPoses: true, showDeleted: false,
};

const app = { S };
let task = null;

// ---------- start screen ----------

async function initStart() {
  const nameInput = $("#annotator");
  nameInput.value = S.annotator;
  nameInput.addEventListener("input", () => {
    S.annotator = nameInput.value.trim();
    setPref("webgui.annotator", S.annotator);
    renderItems();
  });

  const datasets = await serverDatasets();
  S.mode = datasets ? "server" : "folder";
  document.querySelectorAll(`.${S.mode}-mode`).forEach((el) => { el.hidden = false; });
  if (S.mode === "server") await initServerMode(datasets);
  else await initFolderMode();
}

function openItemFromHash() {
  const stem = new URLSearchParams(location.hash.slice(1)).get("item");
  if (stem && S.dataset && S.store && S.dataset.items.some((it) => it.stem === stem)) openItem(stem);
}

async function initFolderMode() {
  const ok = "VideoDecoder" in window && "showDirectoryPicker" in window;
  $("#unsupported").hidden = ok;
  if (!ok) return;
  $("#pick-data").onclick = () => pickFolder("data", "read");
  $("#pick-labels").onclick = () => pickFolder("labels", "readwrite");
  for (const [key, mode] of [["data", "read"], ["labels", "readwrite"]]) {
    const h = await recallHandle(key);
    if (!h) continue;
    if ((await h.queryPermission({ mode })) === "granted") { await useFolder(key, h); continue; }
    const btn = $(`#reopen-${key}`);
    btn.hidden = false;
    btn.textContent = `Reopen “${h.name}”`;
    btn.onclick = async () => { // the browser asks again after a restart; needs a click
      if ((await h.requestPermission({ mode })) === "granted") await useFolder(key, h);
    };
  }
  startMsg(S.dataset && S.store ? "" : "Choose the data folder and the labels folder to start.");
}

async function pickFolder(key, mode) {
  try {
    const h = await showDirectoryPicker({ id: `webgui-${key}`, mode });
    await rememberHandle(key, h);
    await useFolder(key, h);
  } catch (e) {
    if (e.name !== "AbortError") startMsg(`Couldn't open folder: ${e.message}`);
  }
}

async function useFolder(key, h) {
  $(`#reopen-${key}`).hidden = true;
  $(`#${key}-name`).textContent = h.name;
  if (key === "data") {
    startMsg("Reading folder…");
    S.dataset = await datasetFromHandle(h);
    startMsg(S.dataset.items.length ? "" : "No .mp4 + .slp pairs in this folder.");
  } else {
    S.store = new FolderStore(h);
  }
  await renderItems();
  openItemFromHash();
}

async function initServerMode(datasets) {
  $("#unsupported").hidden = "VideoDecoder" in window;
  S.store = new ServerStore();
  const select = $("#dataset");
  select.innerHTML = datasets.map((d) =>
    `<option value="${d.name}" ${d.available ? "" : "disabled"}>${d.name}${d.available ? "" : " (not reachable)"}</option>`).join("");
  const wanted = new URLSearchParams(location.search).get("dataset") ?? getPref("webgui.dataset");
  const first = datasets.find((d) => d.name === wanted && d.available) ?? datasets.find((d) => d.available);
  if (!first) return startMsg("The server has no reachable datasets. Check its config.toml.");
  select.value = first.name;
  select.onchange = () => useServerDataset(select.value);
  await useServerDataset(first.name);
  openItemFromHash();
}

async function useServerDataset(name) {
  setPref("webgui.dataset", name);
  history.replaceState(null, "", `?dataset=${encodeURIComponent(name)}${location.hash}`);
  startMsg("Loading clip list…");
  try {
    S.dataset = await openServerDataset(name);
    startMsg(S.dataset.items.length ? "" : "No .mp4 + .slp pairs in this dataset.");
  } catch (e) {
    S.dataset = null;
    startMsg(`Couldn't list ${name}: ${e.message}`);
  }
  await renderItems();
}

function startMsg(t) { $("#start-msg").textContent = t; }

async function renderItems() {
  const table = $("#items");
  table.hidden = !S.dataset;
  if (!S.dataset) return;
  const status = S.store ? await S.store.status(S.dataset.name) : {};
  const me = safeName(S.annotator);
  table.querySelector("tbody").innerHTML = S.dataset.items.map((it) => {
    const tags = (status[it.stem] ?? []).map((s) =>
      `<span class="tag ${safeName(s.annotator) === me ? "mine" : ""} ${s.done ? "done" : ""}">${s.annotator}: ${s.events}${s.done ? " ✓" : ""}</span>`).join("");
    return `<tr data-stem="${it.stem}"><td>${it.stem}</td><td class="muted">${it.slp}</td><td>${tags || '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
  table.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => openItem(tr.dataset.stem)));
}

// ---------- opening a clip ----------

async function openItem(stem) {
  if (!S.annotator) return startMsg("Enter your name first: labels are saved per person.");
  if (!S.store) return startMsg("Choose a labels folder first.");
  if (!S.dataset) return;
  const it = S.dataset.items.find((x) => x.stem === stem);
  if (!it) return startMsg(`No clip ${stem}`);
  $("#start").hidden = true;
  $("#label").hidden = false;
  $("#item-name").textContent = stem;
  $("#who").textContent = `as ${S.annotator}`;
  loading("Opening video and reading poses…");
  try {
    const { mp4, slp } = await it.open();
    const [video, slpData] = await Promise.all([VideoReader.open(mp4), loadSlp(slp)]);
    if (video.nFrames !== slpData.nFrames) {
      throw new Error(`Video has ${video.nFrames} frames but the pose file says ${slpData.nFrames}. ` +
        "Stopping here: proofreading against a mismatched video would be wrong.");
    }
    Object.assign(S, {
      item: it, video, slp: slpData,
      index: { nFrames: slpData.nFrames, frameStart: slpData.frameStart, track: slpData.track },
      sel: null, range: null, undo: [], redo: [], dirty: false, conflict: false, pendingLog: [], frame: 0,
    });
    const source = { slp_name: slpData.name, slp_size: slpData.size, n_frames: slpData.nFrames, n_instances: slpData.nInstances };
    let labels = await S.store.load(S.dataset.name, stem, S.annotator);
    if (labels && labels.source?.n_instances !== source.n_instances) {
      alert("Your saved labels were made against a different pose file (instance counts differ). " +
        "They are loaded anyway; check them carefully.");
    }
    S.labels = labels ?? emptyLabels({ dataset: S.dataset.name, stem, annotator: S.annotator, tracks: slpData.tracks, source });
    task = createIdentityTask(app);
    task.recompute();
    player.setVideo(video.width, video.height);
    $("#n-frames").textContent = video.nFrames - 1;
    $("#frame-input").max = video.nFrames - 1;
    loading(null);
    const hashF = Number(new URLSearchParams(location.hash.slice(1)).get("f"));
    refresh();
    await seek(Number.isFinite(hashF) ? hashF : 0);
  } catch (e) {
    console.error(e);
    loading(`Couldn't open ${stem}:\n${e.message}`);
  }
}

function loading(msg) {
  const el = $("#loading");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

async function closeItem() {
  stop();
  if (S.dirty) await saveNow(false);
  S.item = null;
  $("#label").hidden = true;
  $("#start").hidden = false;
  history.replaceState(null, "", location.pathname + location.search);
  await renderItems();
}

// ---------- drawing and seeking ----------

let drawToken = 0;
async function seek(f, { fromPlayback = false } = {}) {
  if (!S.video) return;
  f = Math.max(0, Math.min(S.video.nFrames - 1, Math.round(f)));
  S.frame = f;
  const token = ++drawToken;
  const y = S.video.cached(f) ?? (await S.video.getFrame(f));
  if (token !== drawToken) return;
  draw(y);
  if (!fromPlayback) S.video.prefetch(f);
}

function draw(y) {
  const f = S.frame;
  player.draw({
    y, instances: task.instancesAt(f), edges: S.slp.edges,
    showPoses: S.showPoses, showDeleted: S.showDeleted, name: (t) => S.labels.tracks[t] ?? (t < 0 ? "untracked" : `track_${t}`),
  });
  $("#frame-input").value = f;
  const fps = S.video.fps || 50;
  const t = f / fps;
  $("#time").textContent = `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;
  timeline.setFrame(f);
  setHashFrame(f);
}

let hashTimer = null;
function setHashFrame(f) {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => history.replaceState(null, "", `#item=${encodeURIComponent(S.item.stem)}&f=${f}`), 300);
}

function refresh() {
  if (!S.labels) return;
  timeline.setData({
    nFrames: S.index.nFrames, fps: S.video.fps, lanes: task.lanes(), events: S.labels.events, reviewed: S.labels.reviewed,
  });
  timeline.setRange(S.range);
  $("#range-readout").textContent = S.range ? `range ${S.range[0]}–${S.range[1] - 1}` : "";
  task.panel($("#panel"));
  draw(S.video.cached(S.frame));
}

// ---------- playback ----------

function play() {
  if (S.playing || !S.video) return;
  S.playing = true;
  $("#play").textContent = "❚❚";
  let base = performance.now(), f0 = S.frame;
  const tick = async () => {
    if (!S.playing) return;
    const want = Math.min(S.video.nFrames - 1, f0 + Math.floor(((performance.now() - base) / 1000) * S.video.fps * S.speed));
    if (want !== S.frame) {
      if (!S.video.cached(want)) { // decoding behind: wait, then resume from here without skipping
        await S.video.getFrame(want);
        base = performance.now();
        f0 = want;
      }
      await seek(want, { fromPlayback: true });
      S.video.prefetch(want);
    }
    if (want >= S.video.nFrames - 1) stop();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stop() {
  S.playing = false;
  $("#play").textContent = "▶";
}

// ---------- changes, undo, saving ----------

const snapshot = () => JSON.stringify({ events: S.labels.events, reviewed: S.labels.reviewed, tracks: S.labels.tracks, done: S.labels.done });
function restore(snap) {
  Object.assign(S.labels, JSON.parse(snap));
}

app.change = (mutate, log) => {
  S.undo.push(snapshot());
  if (S.undo.length > 500) S.undo.shift();
  S.redo = [];
  mutate(S.labels);
  afterChange(log);
};

function afterChange(log) {
  task.recompute();
  S.dirty = true;
  S.pendingLog.push(log);
  chip("dirty", "unsaved");
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => saveNow(false), AUTOSAVE_MS);
  refresh();
}

function undo(redo = false) {
  const from = redo ? S.redo : S.undo, to = redo ? S.undo : S.redo;
  if (!from.length) return toast(redo ? "Nothing to redo" : "Nothing to undo");
  to.push(snapshot());
  restore(from.pop());
  afterChange({ op: redo ? "redo" : "undo" });
}

async function saveNow(snap) {
  clearTimeout(S.saveTimer);
  if (S.saving) await S.saving;
  if ((!S.dirty && !snap) || S.conflict) return;
  const log = S.pendingLog;
  S.pendingLog = [];
  S.dirty = false;
  chip("dirty", "saving…");
  S.saving = S.store.save(S.labels, { changes: log, snapshot: !!snap })
    .then((updated) => {
      S.labels.updated = updated; // the server's stamp: our base for the next save
      chip("", "saved");
    })
    .catch((e) => {
      console.error(e);
      S.dirty = true;
      S.pendingLog = log.concat(S.pendingLog);
      if (e instanceof ConflictError) { // never overwrite: someone (probably you, elsewhere) saved newer labels
        S.conflict = true;
        chip("error", "changed elsewhere: reload");
        alert(`${e.message}\nReload this page to continue from the newest saved version. ` +
          "Edits made here since the last save are not saved.");
        return;
      }
      chip("error", "save failed: retrying");
      S.saveTimer = setTimeout(() => saveNow(false), 5000);
    })
    .finally(() => { S.saving = null; });
  return S.saving;
}
app.saveNow = saveNow;

function chip(cls, text) {
  const c = $("#save-chip");
  c.className = `chip ${cls}`;
  c.textContent = text;
}

let toastTimer = null;
function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.append(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

Object.assign(app, { seek, refresh, toast });

// ---------- widgets and keys ----------

const player = new Player($("#video"), { onPick: (inst) => task?.pick(inst) });
const timeline = new Timeline($("#timeline"), {
  onSeek: (f) => { stop(); seek(f); },
  onSelect: (r) => { S.range = r; timeline.setRange(r); $("#range-readout").textContent = `range ${r[0]}–${r[1] - 1}`; task.panel($("#panel")); },
  onLane: (t) => task?.lane(t),
});
app.timeline = timeline;

$("#back").onclick = closeItem;
$("#play").onclick = () => (S.playing ? stop() : play());
$("#speed").onchange = (e) => { S.speed = Number(e.target.value); if (S.playing) { stop(); play(); } };
$("#frame-input").onchange = (e) => seek(Number(e.target.value));
const levels = () => player.setLevels(Number($("#black").value), Number($("#white").value));
$("#black").oninput = levels;
$("#white").oninput = levels;
$("#show-poses").onchange = (e) => { S.showPoses = e.target.checked; refresh(); };
$("#show-deleted").onchange = (e) => { S.showDeleted = e.target.checked; refresh(); };
$("#help-btn").onclick = () => { $("#help").hidden = false; };
$("#help-close").onclick = () => { $("#help").hidden = true; };

document.addEventListener("keydown", (ev) => {
  if ($("#label").hidden || !task) return;
  if (ev.target instanceof Element && ev.target.matches("input[type=number], input[type=range], input:not([type]), select") && ev.key !== "Escape") return;
  const mod = ev.metaKey || ev.ctrlKey;
  const step = ev.altKey ? 10 * S.video.fps : ev.shiftKey ? S.video.fps : 1;
  let handled = true;
  if (ev.code === "Space") S.playing ? stop() : play();
  else if (ev.key === "ArrowRight") { stop(); seek(S.frame + step); }
  else if (ev.key === "ArrowLeft") { stop(); seek(S.frame - step); }
  else if (ev.key === "Home") seek(0);
  else if (ev.key === "End") seek(S.video.nFrames - 1);
  else if (mod && ev.code === "KeyZ") undo(ev.shiftKey);
  else if (mod && ev.code === "KeyY") undo(true);
  else if (mod && ev.code === "KeyS") { S.dirty = true; saveNow(true); }
  else if (mod) handled = false;
  else if (ev.key === "Escape") { S.range = null; S.sel = null; $("#help").hidden = true; refresh(); }
  else if (ev.key === "[") { S.range = [S.frame, Math.max(S.frame + 1, S.range?.[1] ?? S.video.nFrames)]; refresh(); }
  else if (ev.key === "]") { S.range = [Math.min(S.range?.[0] ?? S.frame, S.frame), S.frame + 1]; refresh(); }
  else if (ev.code === "KeyP") { S.showPoses = !S.showPoses; $("#show-poses").checked = S.showPoses; refresh(); }
  else if (ev.code === "KeyD") { S.showDeleted = !S.showDeleted; $("#show-deleted").checked = S.showDeleted; refresh(); }
  else if (ev.key === "?") $("#help").hidden = !$("#help").hidden;
  else handled = task.key(ev);
  if (handled) ev.preventDefault();
});

window.addEventListener("beforeunload", (ev) => {
  if (S.dirty) { saveNow(false); ev.preventDefault(); }
});

// For automated checks (Playwright): frame hashes to compare with Python's decoder.
window.__webgui = {
  S, seek, useFolder,
  frameHash: async (f) => sha1Hex(await S.video.getFrame(f)),
  loadEvents: (events) => app.change((labels) => { labels.events = events; }, { op: "import", n: events.length }),
};

initStart().catch((e) => { console.error(e); startMsg(String(e)); });
