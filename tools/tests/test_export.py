import json

import h5py
import numpy as np

from webgui_tools.derive_events import derive, final_targets
from webgui_tools.export import export_slp, uncertain_log_rows
from webgui_tools.identity import SCHEMA
from webgui_tools.slp import instance_keys, read_index

FRAMES = [[0, 1, 2], [0, 1], [], [1, 0, -1], [0, 1]]


def labels_for(slp, events, tracks=("mouse_0", "mouse_1", "mouse_2")):
    si = read_index(slp)
    return {"schema": SCHEMA, "stem": "X", "tracks": list(tracks), "events": events, "reviewed": [],
            "source": {"n_frames": si.n_frames, "n_instances": len(si.rows)}}


def final_by_key(slp):
    with h5py.File(slp) as f:
        names = [json.loads(t)[1] for t in f["tracks_json"][:]]
        tr = f["instances"]["track"][:]
    return {k: (names[t] if t >= 0 else None) for k, t in zip(instance_keys(slp), tr)}


def test_read_index_fills_empty_frames(make_slp):
    si = read_index(make_slp("a.slp", FRAMES))
    assert si.n_frames == 5
    assert list(si.index.frame_start) == [0, 3, 5, 5, 8, 10]
    assert list(si.index.track) == [0, 1, 2, 0, 1, 1, 0, -1, 0, 1]
    assert si.tracks == ["mouse_0", "mouse_1", "mouse_2"]


def test_export_without_events_keeps_everything(make_slp, tmp_path):
    src = make_slp("a.slp", FRAMES)
    out = tmp_path / "out.slp"
    export_slp(labels_for(src, []), src, out)
    assert final_by_key(out) == final_by_key(src)


def test_export_applies_swap_and_delete(make_slp, tmp_path):
    src = make_slp("a.slp", FRAMES)
    out = tmp_path / "out.slp"
    events = [{"kind": "map", "f0": 3, "f1": None, "map": {"0": 1, "1": 0}},
              {"kind": "map", "f0": 0, "f1": 1, "map": {"2": None}},
              {"kind": "instance", "f": 3, "i": 2, "dst": 2}]
    export_slp(labels_for(src, events), src, out)
    got = read_index(out)
    assert list(got.index.frame_start) == [0, 2, 4, 4, 7, 9]
    assert list(got.index.track) == [0, 1, 0, 1, 0, 1, 2, 1, 0]
    # surviving keypoints are byte-identical
    assert set(instance_keys(out)) <= set(instance_keys(src))


def test_derive_roundtrip_reproduces_fixed_file(make_slp, tmp_path):
    src = make_slp("a.slp", FRAMES)
    # A "fixed" file as SLEAP would write it: frame 0 drops mouse_2, frames 3.. swapped,
    # the untracked instance becomes mouse_2, and frame 1 has a split (both -> mouse_0 / deleted).
    fixed_frames = [[0, 1, None], [0, None], [], [0, 1, 2], [1, 0]]

    def kp(f, i):
        return np.array([[f * 10.0 + i, n] for n in range(3)])

    keep = [[(i, t) for i, t in enumerate(row) if t is not None] for row in fixed_frames]
    fixed = make_slp("fixed.slp", [[t for _, t in row] for row in keep],
                     keypoints=lambda f, j: kp(f, keep[f][j][0]))
    si, targets, names, n_added = final_targets(src, fixed)
    assert n_added == 0
    events = derive(si, targets)
    out = tmp_path / "out.slp"
    export_slp(labels_for(src, events, names), src, out)
    assert final_by_key(out) == final_by_key(fixed)
    assert any(e["kind"] == "map" for e in events)


def test_uncertain_log_rows_match_js():
    labels = {"tracks": ["mouse_2", "mouse_0"], "events": [
        {"kind": "map", "action": "swap", "f0": 10, "f1": None, "map": {"0": 1, "1": 0}, "note": ""},
        {"kind": "uncertain", "f0": 20, "f1": 31, "tracks": [0, 1], "resolved": "unsure", "note": "huddle"},
        {"kind": "instance", "f": 5, "i": 1, "dst": None, "note": ""}]}
    rows = uncertain_log_rows(labels, "ID000", 15000)
    assert rows[1] == ["ID000", 10, 14999, "swap mouse_2<->mouse_0", "yes"]
    assert rows[2] == ["ID000", 20, 30, "cannot tell mouse_2, mouse_0: huddle", "unsure"]
    assert rows[3] == ["ID000", 5, 5, "delete instance 1", "yes"]
