# Web_GUI: unified HCM ground-truth labeler (v1: identity proofreading)

## Context

The Talmo lab homecage-monitoring (HCM) group labels ground truth with improvised tools:
- **Identity (Leo's batch 02/04).** The SLEAP desktop GUI (`Ctrl+<n>` reassigns a track) plus a hand-kept `uncertain_log.csv`. The log never came back, and it was the actual measurement (fixes per clip).
- **Sleep/episode review (Leo's p64).** Overlays are burnt into the mp4 and the verdict is typed into `clips.csv`.
- **Tail-switch identity (Tom/Ketan, `/Volumes/talmo/than/26-09-reid-v2/labeler`).**
  - A good stdlib-Python + vanilla-JS app.
  - It runs on Tom's workstation, and people reach it over Tailscale.
  - It records no annotator, and keeps one label file per video.

The goal is one GUI with a shared core:
- frame-exact video;
- pose overlay;
- track timeline;
- annotator-attributed event labels;
- saving and export.

Each labeling job is a pluggable **task type**. Scope agreed with the user covers identity/track swaps, sleep/episode review, and later absorbing Tom's tail-switch labeler. **v1 = identity/track swaps only.**

**Access model (user's choice): a static site behind a published link (GitHub Pages under talmolab), running entirely in the browser.** There is no server and no dependence on anyone's workstation. A user who is on the Salk VPN with VAST mounted opens the link and picks a dataset folder. The browser then reads `.mp4` and `.slp` from their own mount:
- video is demuxed by our own small MP4 parser (`js/io/mp4-parse.js`; mp4box.js was dropped) and decoded frame-exact with WebCodecs;
- `.slp` (HDF5) is read with h5wasm in a worker.

Labels are written as JSON into a labels folder the user picks, via the File System Access API. Lab data never leaves Salk. Chrome/Edge are required in v1 (they have the File System Access API).

Python is used only offline, in a small `uv` tools package:
- transcode mp4v clips to H.264;
- export the corrected `.slp` and `uncertain_log.csv` from the label JSON;
- validate against Leo's reference.

Work lives in `/Users/anirudhannabathula/Desktop/Talmo/Web_GUI/` (currently empty). Later it goes to `/Volumes/talmo/anirudh/` and a talmolab GitHub repo. **Nothing is written under `/Volumes/talmo` during development.** Any write to the share later (e.g. transcoded clips into `anirudh/`) needs an explicit OK first.

## Data facts that shape the design

- **Batch 02:** `/Volumes/talmo/leo/2026-07-28-HCM-Sleep/gt_release/batch02_identity/clips/IDxxx.{mp4,slp}`.
  - 46 clips, 15,000 frames each, 1280×1024 grayscale, 50 fps.
  - The `.slp` files have tracks `mouse_N` attached.
  - **The video codec is `mp4v` (MPEG-4 Part 2), which browsers cannot decode**, so a one-time transcode to H.264 is needed.
- **Batch 04:** `gt_release/batch04_six_hours/GT0x.{mp4,tracked.slp}`.
  - **H.264 (`avc1`)**, 180,000 frames, 111–202 MB mp4, ~250 MB slp.
  - Second target, after clips work.
- **Human-corrected reference:** `/Volumes/talmo/leo/2026-07-28-HCM-Sleep/gt_returned/batch02_identity/IDxxx fixed.slp`.
- **Leo's scorer:** `scripts/p57_score_identity.py` matches instances by (frame, exact keypoints), so the export must leave keypoints untouched.
- **Skeleton:** 15 nodes (hcm-core `facts/`).
- **No `ffmpeg` on the Mac.** The tools package uses `imageio-ffmpeg` (bundles a binary) via uv. `uv`, Node 20 and git are present.

## Design

### Layout
```
Web_GUI/
  index.html  css/app.css
  js/
    io/source.js        ByteSource interface: FileSource (FS Access File, blob.slice) | UrlSource (HTTP Range; dev/tests)
    io/mp4.js           mp4box.js demux -> sample table (sync samples); WebCodecs VideoDecoder;
                        getFrame(f): decode from the preceding keyframe; LRU of ImageBitmaps; prefetch ahead
    io/slp.js + io/slp.worker.js   h5wasm in a worker (WORKERFS mount for File, so it reads lazily):
                        skeleton, track names, per-frame instances -> points (F,I,N,2) Float32, track (F,I) Int16
    core/labels.js      labels folder (FS Access dir handle kept in IndexedDB); <stem>/<annotator>.json written with
                        createWritable (atomic on close) + <stem>/<annotator>.log.jsonl append
    core/player.js      canvas: frame + skeletons coloured by corrected track; wheel zoom / drag pan
    core/timeline.js    one lane per track (presence run-lengths), event markers, reviewed spans, playhead, range select
    core/app.js         state, routing (URL hash), keys, autosave (1.2 s) + undo stack
    tasks/identity.js   PURE event model (no DOM): applyEvents, validate, toUncertainLogRows
    tasks/identity-ui.js  tools/panel for the identity task
  vendor/               pinned copies of mp4box.js and h5wasm (no CDN dependence)
  tests/js/*.test.mjs   node --test (pure modules: identity events, slp row decoding, mp4 sample-table logic)
  tests/fixtures/identity_cases.json   shared JS/Python semantics fixtures
  tools/                uv project `webgui-tools`: numpy, sleap-io, imageio-ffmpeg, pytest
    transcode.py        mp4v -> H.264 (libx264, yuv420p, crf ~18, -g 50, +faststart); asserts frame count unchanged
    export.py           labels JSON + original .slp -> corrected .slp (only instance.track changed) + uncertain_log.csv
    derive_events.py    original .slp vs fixed .slp -> event list (validation helper)
    tests/
  docs/specs/2026-10-22-identity-labeler-design.md
  README.md  .gitignore (.cache/, local labels, transcoded media)
```
Dev serving uses `tools/devserve.py`, because the stdlib `http.server` ignores HTTP Range requests. Localhost is a secure context, so the File System Access API and WebCodecs work there. GitHub Pages deployment is deferred until the repo moves to talmolab.

### Ideas ported from Tom's labeler (credit in README)
- Frame-exact seeking with verification.
- A frame cache with prefetch.
- Atomic save + append-only `.log.jsonl`.
- Autosave + an undo stack.
- URL-hash state.
- "Reviewed window" certification.
- The key layout (`Space`, `←/→` with Shift 1 s / Alt 10 s, `Ctrl+Z/Y/S`, `P`, `?`).

His kymograph pipeline is left for the later tail-switch task.

### Identity label model (schema `webgui-identity/1`)

Revised 2026-10-22 after diffing Renee's returned `IDxxx fixed.slp` against the originals:
- annotators delete many spurious instances (815–13,168 per clip);
- they assign untracked instances (`track = -1`);
- a few frames hold two instances of the same track;
- reassignments happen simultaneously (e.g. 1→0 and 2→1 over the same range).

The model therefore has range-level *simultaneous maps* plus per-instance edits:
```
{schema, dataset, stem, annotator, updated,
 source: {slp_name, slp_size, n_frames, n_instances},
 tracks: ["mouse_2", "mouse_0", ...],   // source names; new tracks are appended
 events:   [{id, kind, action, created, note, ...}],
 reviewed: [{f0, f1, at}]}
kinds (applied in order to the current state; track -1 = untracked):
  map       {f0, f1|null, map: {"<src>": dst|null}}   simultaneous on [f0,f1) (null f1 = to end);
            dst null = delete. action: "swap" | "relabel" | "delete" (for display/counting)
  instance  {f, i, dst|null}   one instance (i = index within frame in source-file order); null = delete
  uncertain {f0, f1, tracks, resolved: "yes"|"no"|"unsure"}   "cannot tell"; no track change
```
- `applyEvents(index, events)` returns `{track, deleted}` per instance. It is pure, and implemented identically in `js/tasks/identity.js` and `tools/webgui_tools/identity.py`. Both are tested against `tests/fixtures/identity_cases.json`.
- **UI mapping:**
  - digit N on a selected animal: if N is present in the range it's a swap, otherwise a relabel (range = timeline selection, else current frame → end); `Alt+digit` affects this frame only (`instance`);
  - `Del` deletes this instance in this frame;
  - `Shift+Del` deletes the track over the range.
- `derive_events.py` (original vs fixed `.slp`) merges consecutive frames that share the same orig→final mapping into `map` events, and falls back to `instance` events where a mapping is ambiguous (duplicates, several untracked instances).
- Annotators each have their own file, so there are no write conflicts. The name is prompted on first visit and kept in localStorage.
- The browser offers a direct download of `uncertain_log.csv` in Leo's columns `clip_id,frame_start,frame_end,what_happened,resolved`. There is one row per swap/relabel (resolved=yes) and per uncertain event, so the log can't go missing.

### UI
- **Start screen.** Annotator name, a "Pick dataset folder", and a "Pick labels folder". The item list shows per-annotator status.
- **Video canvas.** Skeletons are coloured by the corrected track, with a label like `mouse_1`.
- **Timeline lanes.** Drag to select a range.
- **Fixes:**
  - select two skeletons or lanes, then `X` swaps from here to the end (`Shift+X` swaps over the selection only);
  - `1–9` relabels the selected track;
  - `U` marks the selection uncertain, with a note;
  - `Enter` marks the visible range reviewed.
- **Side panel.** Event list (click to seek, delete, edit note), % reviewed, Done.

### Deferred (not v1)
- Sleep/episode-review task.
- Tail-switch task.
- Batch-04 hour files (needs lazy per-range pose decoding; check GOP length for seek cost).
- GitHub Pages deployment and talmolab repo.
- Writing transcoded batch-02 clips to `/Volumes/talmo/anirudh/`. The user allows VAST writes only there; no repo publishing (the user creates the repo).
- Safari/Firefox fallback (read-only folder input + label download).
- Multi-annotator agreement view, blinding/gold-item controls, hcm-core camera labels.

## Steps
1. `git init` `Web_GUI/`. Write the spec into `docs/specs/`. Add `.gitignore`, the `tools/` uv project, and vendor the pinned mp4box.js and h5wasm.
2. `tools/transcode.py`. Transcode 2–3 batch-02 clips into `Web_GUI/.cache/media/` and assert 15,000 frames each.
3. `tasks/identity.js` + `tools/export.py`, test-first, against the shared fixtures.
4. `io/slp.js` worker. Test decoding on ID000 (track names, instance counts per frame vs sleap-io in Python).
5. `io/mp4.js`. Check frame exactness: the frame-f pixel hash in the browser equals the frame-f hash decoded in Python from the same H.264 file.
6. `core/labels.js`, player, timeline, identity UI, keys, autosave, undo.
7. `tools/derive_events.py` + README (run, data, credits).

## Verification
- `node --test tests/js` and `cd tools && uv run pytest` pass.
- Serve with `python3 -m http.server 8770`. Drive with Playwright (UrlSource dev mode with a `?src=` URL, because a folder picker can't be scripted): load ID000, screenshot video + skeletons + timeline, scrub, and assert the displayed frame index matches the decoded-frame hash. Do a manual check with the real folder pickers in Chrome on `/Volumes/talmo`.
- **Round-trip against the human reference.**
  1. `derive_events.py ID000.slp "ID000 fixed.slp"` produces events.
  2. Load the events in the GUI and save.
  3. `export.py` produces a corrected `.slp` whose per-instance tracks equal `fixed.slp` exactly.
  4. Leo's p57 logic (copied locally) gives the same swap counts for both.
- Confirm nothing under `/Volumes/talmo` changed (compare folder mtimes before and after).

## Implementation notes (2026-10-22)

- **Event model:** the `map`/`instance`/`uncertain` model replaced swap/relabel; see the label-model section.
- **Frame cache:** luma planes only. The cap never evicts the segment just decoded, because rig hour files have a keyframe only every 250 frames.
- **Verification:**
  - JS frame hashes equal ffmpeg's (ID000 transcode; GT04 hour file with B-frames).
  - GUI → export of Renee's ID001 corrections equals `ID001 fixed.slp`.
  - p57 metrics and swap lists are identical.

## Revision: hosted on a lab server (2026-10-22)

**Reason:** annotators can't be expected to run Python, and export/transcode are Python. So the
static-site and File System Access design is replaced by one FastAPI server
(`tools/webgui_tools/server.py`) on a lab machine with VAST mounted. It:
- serves the frontend;
- serves `/data/<dataset>/<file>` read-only, with HTTP Range;
- stores labels under `labels_dir` (one JSON per annotator, plus a `.log.jsonl`);
- answers 409 on a stale `base`;
- builds the corrected `.slp` and `uncertain_log.csv` from the saved labels.

**Unchanged:** decoding stays in the browser (WebCodecs + h5wasm). The folder pickers,
`FolderStore`/`LocalStore` and `devserve.py` are removed. The config lives in
`config.toml` (template `config.example.toml`), and the deploy unit is `deploy/webgui.service`.

**Open, pending Leo:** host machine, VAST mount path, network reachability/port, service account,
whether to require a login, which datasets to serve first.

## Revision: GitHub Pages first, server optional (2026-10-27)

After meeting Leo: host on GitHub Pages (https://anirudh9280.github.io/WebGUI/) for now; mount on a
lab server later only if complex Python must run.

**Two modes, detected automatically** (a probe of `api/datasets`):
- **Folder mode:** File System Access pickers for the data and labels folders on the user's VAST mount;
  `FolderStore` with the same conflict rule as the server.
- **Server mode:** everything in the server revision above.

**Exports in folder mode:**
- `uncertain_log.csv` is built in the browser.
- The corrected `.slp` stays a Python command (`webgui_tools.export`).

Chrome/Edge only in folder mode.

**Data:** converted batch-02 clips (H.264 + `.slp`) are in `talmo/anirudh/web_gui/data/batch02_identity/`;
the suggested shared labels folder is `talmo/anirudh/web_gui/labels/`.
