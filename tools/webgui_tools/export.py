"""Apply a Web_GUI identity labels JSON to the original .slp.

Writes a corrected .slp (only instance tracks change; deleted instances are dropped;
keypoints are untouched so Leo's p57 matcher still works) and Leo's uncertain_log.csv.

    uv run python -m webgui_tools.export labels.json ORIGINAL.slp OUT.slp [--log OUT.csv]
"""
import argparse
import csv
import json
import shutil

import h5py
import numpy as np

from .identity import SCHEMA, apply_events
from .slp import read_index


def _name(tracks, t):
    return "untracked" if t == -1 else (tracks[t] if t < len(tracks) else f"track_{t}")


def _describe(ev, tracks):
    n = lambda t: _name(tracks, t)  # noqa: E731
    if ev["kind"] == "map":
        pairs = [(int(k), v) for k, v in ev["map"].items()]
        if ev.get("action") == "swap" and len(pairs) == 2:
            return f"swap {n(pairs[0][0])}<->{n(pairs[0][1])}"
        return "; ".join(f"delete {n(s)}" if d is None else f"relabel {n(s)}->{n(d)}" for s, d in pairs)
    if ev["kind"] == "instance":
        return f"delete instance {ev['i']}" if ev["dst"] is None else f"instance {ev['i']} -> {n(ev['dst'])}"
    return "cannot tell " + ", ".join(n(t) for t in ev["tracks"])


def uncertain_log_rows(labels, clip_id, n_frames):
    """Same rows as uncertainLogRows in js/tasks/identity.js (frame_end inclusive)."""
    rows = [["clip_id", "frame_start", "frame_end", "what_happened", "resolved"]]
    for ev in labels["events"]:
        if ev["kind"] == "instance":
            f0, f1 = ev["f"], ev["f"] + 1
        else:
            f0, f1 = ev["f0"], n_frames if ev.get("f1") is None else ev["f1"]
        what = _describe(ev, labels["tracks"]) + (f": {ev['note']}" if ev.get("note") else "")
        rows.append([clip_id, f0, min(f1, n_frames) - 1, what, ev["resolved"] if ev["kind"] == "uncertain" else "yes"])
    return rows


def export_slp(labels, src, dst):
    if labels.get("schema") != SCHEMA:
        raise ValueError(f"expected schema {SCHEMA}, got {labels.get('schema')}")
    si = read_index(src)
    if labels["source"]["n_instances"] != len(si.rows):
        raise ValueError("labels were made against a different .slp (instance count differs)")
    track, deleted = apply_events(si.index, labels["events"])

    shutil.copyfile(src, dst)
    with h5py.File(dst, "r+") as f:
        inst = f["instances"][:]
        frames = f["frames"][:]
        inst["track"][si.rows] = track
        keep = np.ones(len(inst), dtype=bool)
        keep[si.rows[deleted]] = False
        new_pos = np.concatenate([[0], np.cumsum(keep)])  # old row -> new row
        frames["instance_id_start"] = new_pos[frames["instance_id_start"]]
        frames["instance_id_end"] = new_pos[frames["instance_id_end"]]
        names = list(labels["tracks"])
        if len(track) and track.max() >= len(names):
            names += [f"track_{t}" for t in range(len(names), int(track.max()) + 1)]
        for name, data in [("instances", inst[keep]), ("frames", frames)]:
            del f[name]
            f.create_dataset(name, data=data)
        old = [json.loads(t) for t in f["tracks_json"][:]]
        spawned = [old[t][0] if t < len(old) else 0 for t in range(len(names))]
        del f["tracks_json"]
        f.create_dataset("tracks_json", data=np.array([json.dumps([s, n], separators=(",", ":")).encode() for s, n in zip(spawned, names)]))
    return si


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("labels")
    ap.add_argument("slp")
    ap.add_argument("out")
    ap.add_argument("--log", help="also write uncertain_log.csv here")
    a = ap.parse_args(argv)
    with open(a.labels) as fh:
        labels = json.load(fh)
    si = export_slp(labels, a.slp, a.out)
    if a.log:
        with open(a.log, "w", newline="") as fh:
            csv.writer(fh).writerows(uncertain_log_rows(labels, labels["stem"], si.n_frames))
    print(f"wrote {a.out} ({len(labels['events'])} events)")


if __name__ == "__main__":
    main()
