# HCM Labeler (Web_GUI)

A browser-based ground-truth labeler for the Talmo lab homecage-monitoring (HCM) data. The goal is
one tool for the labeling jobs that are currently spread across the SLEAP GUI, spreadsheets and
one-off apps. **v1 does identity proofreading**: fixing track swaps, spurious tracks and untracked
animals in SLEAP predictions, and logging every fix plus every "cannot tell".

**Open it:** https://anirudh9280.github.io/WebGUI/ (Chrome or Edge, on the Salk VPN with VAST mounted).

The page runs entirely in your browser. It reads clips straight from the VAST share mounted on your
computer and saves labels as JSON into a folder you choose. Nothing is uploaded: the page on GitHub
holds only code, and lab video never leaves Salk. The same code can also be served by a lab server
(see "Lab server mode"); it detects which mode it is in by itself.

## Labeling (annotators)

1. Connect to the Salk VPN and mount VAST in Finder: **Go → Connect to Server** (⌘K),
   `smb://pool1.vast.salk.edu/talmo`.
2. Open https://anirudh9280.github.io/WebGUI/ in **Chrome or Edge**. Other browsers can't read or
   save folders.
3. Enter your name. Labels are saved per person, so several people can label the same clip.
4. **Data folder:** e.g. `talmo/anirudh/web_gui/data/batch02_identity`. Any folder of `<clip>.mp4`
   (H.264) + `<clip>.slp` pairs works.
5. **Labels folder:** e.g. `talmo/anirudh/web_gui/labels`. You get `<dataset>/<clip>/<you>.json`, plus
   `<you>.log.jsonl`, an append-only history of every change.
   The browser remembers both folders, and asks for permission again after a restart.
6. Click a clip. Press `?` for keys. The essentials:

| Key | Does |
|---|---|
| click an animal / a lane name | select it |
| `1`–`9` | make the selected animal track N from the playhead to the end, or over the selected range. A **swap** if N is already there, a **relabel** if not |
| `Alt`+`1`–`9` | reassign just this instance in this frame |
| `Delete` / `Shift+Delete` | delete this instance in this frame / delete the track over the range |
| drag on the timeline, `[` `]`, `Esc` | select a range, set its start or end, clear it |
| `U` | "cannot tell" over the range, with a note |
| `Enter` | mark the range (or what's on screen) as reviewed |
| `Space`, `←` `→` (`Shift` 1 s, `Alt` 10 s), `N` | play, step, jump to next event |
| `Ctrl/⌘ Z`, `Shift+Z`, `S` | undo, redo, save (it also autosaves) |

The side panel lists every fix. Click one to jump to it, double-click to edit its note, ✕ to remove it.
- **uncertain_log.csv** downloads Leo's log format (`clip_id,frame_start,frame_end,what_happened,resolved`).
- **corrected .slp** is built by a Python command (see "After labeling"); the button shows it.
- `#item=…&f=…` in the URL reopens a clip at a frame.

If someone saves the same person's labels from another tab, this tab stops saving and asks you to reload
instead of overwriting. After the site is updated, press ⌘⇧R once if anything looks out of date.

## Lab server mode (optional, later)

For a future with server-side Python (corrected `.slp` from a button, no folder pickers, any browser),
the same code runs behind `tools/webgui_tools/server.py` on a lab machine with VAST mounted:

```bash
git clone git@github.com:anirudh9280/WebGUI.git ~/Web_GUI && cd ~/Web_GUI
cp config.example.toml config.toml        # set labels_dir and [datasets] to paths on that machine
cd tools && uv run python -m webgui_tools.server --config ../config.toml
```

- **Keep it running:** `deploy/webgui.service` makes it a systemd user service.
- **Writes:** only under `labels_dir`.
- **Conflicts:** a stale save is refused (HTTP 409).
- **Access control:** none beyond the network.
- **API docs:** `/api/docs`.

## Preparing data

Browsers decode H.264 but not the MPEG-4 Part 2 (`mp4v`) that OpenCV writes, which is what Leo's
batch-02 clips use. Convert them once; every frame is kept, and the count is checked:

```bash
cd tools
uv run python -m webgui_tools.transcode OUT_DIR /Volumes/talmo/.../clips/ID000.mp4 ...
```

The matching `.slp` is copied next to each output, so `OUT_DIR` is a ready data folder.
Raw rig video and batch-04 hour files are already H.264 and work as they are.

## After labeling (tools/)

```bash
cd tools
# corrected .slp (only tracks change; deleted instances dropped; keypoints untouched) + log
uv run python -m webgui_tools.export LABELS.json ORIGINAL.slp OUT.slp --log uncertain_log.csv
# turn an existing SLEAP-GUI proofread (e.g. "ID000 fixed.slp") into labeler events
uv run python -m webgui_tools.derive_events ORIGINAL.slp FIXED.slp OUT.json
```

Exported files score identically to the SLEAP-GUI originals under Leo's `p57_score_identity.py`.

## Development

```bash
python3 -m http.server 8771       # folder mode, exactly as on GitHub Pages: http://127.0.0.1:8771
npm run serve                     # server mode with config.dev.toml (.cache/media clips, .cache/labels)
open "http://127.0.0.1:8770/?dataset=batch02_identity#item=ID000"
npm test             # node --test: event model, MP4 demuxer, .slp parser
cd tools && uv run pytest   # event model, export/derive, server API
```

- **Frontend:** no build step and no framework; ES modules plus a vendored copy of [h5wasm](https://github.com/usnistgov/h5wasm) 0.7.8.
- **Deployment:** GitHub Pages serves the repo root as is (`.nojekyll`, no build). Pushing to `main` updates the site within a minute or two.
- **Optional server:** FastAPI (`tools/webgui_tools/server.py`).
- **Video and poses are decoded in the browser** in both modes (WebCodecs, h5wasm). A server would only send file bytes, so it needs no GPU.
- MP4 demuxing is in `js/io/mp4-parse.js`. It maps frame N to the Nth frame in presentation order (B-frames included), matching ffmpeg, OpenCV and SLEAP.
- `js/tasks/identity.js` and `tools/webgui_tools/identity.py` implement the same event semantics. Both are tested against `tests/fixtures/identity_cases.json`.
- The real-data tests (`tests/js/slp.test.mjs`, `mp4.test.mjs`) skip if `.cache/` or VAST is missing. To create the fixtures, transcode ID000 into `.cache/media/batch02_identity/`, then dump Python's index to `.cache/ID000.index.json` (see the test file).

Layout:

| Path | Contents |
|---|---|
| `js/io/` | byte sources, MP4 demux + WebCodecs decode, `.slp` parsing in a worker |
| `js/core/` | app shell, video canvas, timeline, datasets and label storage (folder + server modes) |
| `js/tasks/` | identity task (pure model + UI) |
| `tools/` | Python: transcode, export, derive events, optional lab server (uv project) |
| `deploy/` | systemd unit |
| `docs/specs/` | design |

## Verified so far

- Browser frames are bit-identical to ffmpeg. The SHA-1 of the luma plane matches at keyframe boundaries and on random seeks, on transcoded clips and on a 180,000-frame B-frame hour file read live from VAST.
- `.slp` parsing matches the Python reader on ID000 (15,000 frames, 30,801 instances).
- Renee's returned batch-02 proofreads (ID000, ID001, ID005) round-trip exactly. Deriving events, loading them in the GUI and exporting reproduces `fixed.slp` instance for instance, and p57 gives identical metrics and swap lists.

## Credits and roadmap

- Ideas borrowed from Tom Han's tail-switch labeler (`than/26-09-reid-v2/labeler`): frame-exact seeking, reviewed-window certification, append-only change log, autosave and undo, the key layout.
- Data, ground-truth rules and the batch-02 design come from Leo's `hcm-core` and `2026-07-28-HCM-Sleep`.

Next tasks on the shared core:
- running on a lab server when server-side Python is needed (code is ready; see above);
- sleep/episode review (motion trace + detector state + verdict);
- Tom's tail-switch kymograph task;
- hour-long files (lazy pose loading);
- an agreement view across annotators.
