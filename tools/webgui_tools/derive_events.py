"""Derive identity events that turn an original .slp into a corrected one (e.g. a
SLEAP-GUI-proofread `IDxxx fixed.slp`). Used to validate export and to import
past SLEAP proofreading as Web_GUI labels.

Instances are matched by (frame, exact keypoints). Consecutive frames whose
orig->final track mapping agrees merge into one `map` event; frames where one
source track splits several ways fall back to per-instance `instance` events.

    uv run python -m webgui_tools.derive_events ORIGINAL.slp FIXED.slp OUT.json [--annotator NAME]
"""
import argparse
import json
import os

import h5py

from .identity import SCHEMA
from .slp import instance_keys, read_index, track_names


def final_targets(src, fixed):
    """Per index position of `src`: final track id (in src's track numbering) or None if deleted."""
    si = read_index(src)
    with h5py.File(fixed, "r") as f:
        fixed_tracks = track_names(f)
        fixed_inst_track = f["instances"]["track"][:]
    names = list(si.tracks)
    to_src = {}
    for t, n in enumerate(fixed_tracks):
        if n not in names:
            names.append(n)
        to_src[t] = names.index(n)
    to_src[-1] = -1
    fixed_by_key = {k: to_src[int(fixed_inst_track[r])] for r, k in enumerate(instance_keys(fixed))}
    src_keys = instance_keys(src)
    targets = [fixed_by_key.get(src_keys[r]) for r in si.rows]
    n_added = len(fixed_by_key) - sum(t is not None for t in targets)
    return si, targets, names, n_added


def derive(si, targets):
    idx = si.index
    events = []
    run_f0, seen = None, {}

    def close(f_end):
        nonlocal run_f0, seen
        m = {str(t): d for t, d in seen.items() if d != t}
        if run_f0 is not None and m:
            action = "delete" if all(d is None for d in m.values()) else "relabel"
            if len(m) == 2 and all(d is not None for d in m.values()):
                (a, da), (b, db) = [(int(k), v) for k, v in m.items()]
                if da == b and db == a:
                    action = "swap"
            events.append({"kind": "map", "action": action, "f0": run_f0, "f1": f_end, "map": m})
        run_f0, seen = None, {}

    for f in range(idx.n_frames):
        a, b = idx.frame_start[f], idx.frame_start[f + 1]
        per_track = {}
        for k in range(a, b):
            per_track.setdefault(int(idx.track[k]), set()).add(targets[k])
        if any(len(v) > 1 for v in per_track.values()):
            close(f)
            for i, k in enumerate(range(a, b)):
                if targets[k] != int(idx.track[k]):
                    events.append({"kind": "instance", "f": f, "i": i, "dst": targets[k]})
            continue
        frame_map = {t: next(iter(v)) for t, v in per_track.items()}
        if run_f0 is not None and any(seen.get(t, d) != d for t, d in frame_map.items()):
            close(f)
        if run_f0 is None:
            run_f0 = f
        seen.update(frame_map)
    close(idx.n_frames)
    for n, ev in enumerate(events):
        ev.update(id=f"d{n}", created=None, note="derived")
    return events


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("fixed")
    ap.add_argument("out")
    ap.add_argument("--annotator", default="derived")
    a = ap.parse_args(argv)
    si, targets, names, n_added = final_targets(a.src, a.fixed)
    if n_added:
        print(f"warning: {n_added} instances in the fixed file have no match in the source (added or moved); ignored")
    events = derive(si, targets)
    stem = os.path.splitext(os.path.basename(a.src))[0]
    labels = {
        "schema": SCHEMA, "dataset": os.path.basename(os.path.dirname(os.path.abspath(a.src))), "stem": stem,
        "annotator": a.annotator, "updated": None,
        "source": {"slp_name": os.path.basename(a.src), "slp_size": os.path.getsize(a.src),
                   "n_frames": si.n_frames, "n_instances": len(si.rows)},
        "tracks": names, "events": events, "reviewed": [],
    }
    with open(a.out, "w") as fh:
        json.dump(labels, fh, indent=1)
    kinds = {}
    for ev in events:
        kinds[ev.get("action", ev["kind"])] = kinds.get(ev.get("action", ev["kind"]), 0) + 1
    print(f"wrote {a.out}: {len(events)} events {kinds}")


if __name__ == "__main__":
    main()
