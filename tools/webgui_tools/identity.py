"""Identity proofreading event model. Mirrors js/tasks/identity.js; both are checked
against tests/fixtures/identity_cases.json.

An index is the instance table of a clip flattened in source-file order:
frame_start (n_frames + 1,) and track (n_instances,). Track -1 = untracked.
"""
from dataclasses import dataclass

import numpy as np

SCHEMA = "webgui-identity/1"


@dataclass
class Index:
    n_frames: int
    frame_start: np.ndarray  # int64 (n_frames + 1,)
    track: np.ndarray  # int16 (n_instances,)


def index_from_lists(frames):
    frame_start = np.zeros(len(frames) + 1, dtype=np.int64)
    frame_start[1:] = np.cumsum([len(f) for f in frames])
    track = np.array([t for f in frames for t in f], dtype=np.int16)
    return Index(len(frames), frame_start, track)


def _frame_range(index, f0, f1):
    lo = max(0, f0)
    hi = min(index.n_frames, index.n_frames if f1 is None else f1)
    return lo, max(lo, hi)


def apply_events(index, events):
    """Apply events in order; returns (track, deleted) arrays (copies)."""
    track = index.track.copy()
    deleted = np.zeros(len(track), dtype=bool)
    for ev in events:
        if ev["kind"] == "map":
            lo, hi = _frame_range(index, ev["f0"], ev.get("f1"))
            a, b = index.frame_start[lo], index.frame_start[hi]
            seg_t, seg_d = track[a:b], deleted[a:b]
            live = ~seg_d
            new_t, new_d = seg_t.copy(), seg_d.copy()
            for src, dst in ev["map"].items():
                hit = live & (seg_t == int(src))  # match against pre-event state: simultaneous
                if dst is None:
                    new_d[hit] = True
                else:
                    new_t[hit] = dst
            track[a:b], deleted[a:b] = new_t, new_d
        elif ev["kind"] == "instance":
            f, i = ev["f"], ev["i"]
            if not 0 <= f < index.n_frames:
                continue
            k = index.frame_start[f] + i
            if k >= index.frame_start[f + 1] or deleted[k]:
                continue
            if ev["dst"] is None:
                deleted[k] = True
            else:
                track[k] = ev["dst"]
    return track, deleted
