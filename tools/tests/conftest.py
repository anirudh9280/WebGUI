import json

import h5py
import numpy as np
import pytest

INST_DT = np.dtype([("instance_id", "<i8"), ("instance_type", "u1"), ("frame_id", "<u8"), ("skeleton", "<u4"),
                    ("track", "<i4"), ("from_predicted", "<i8"), ("score", "<f4"), ("point_id_start", "<u8"),
                    ("point_id_end", "<u8"), ("tracking_score", "<f4")])
FRAME_DT = np.dtype([("frame_id", "<u8"), ("video", "<u4"), ("frame_idx", "<u8"),
                     ("instance_id_start", "<u8"), ("instance_id_end", "<u8")])
PRED_DT = np.dtype([("x", "<f8"), ("y", "<f8"), ("visible", "?"), ("complete", "?"), ("score", "<f8")])
USER_DT = np.dtype([("x", "<f8"), ("y", "<f8"), ("visible", "?"), ("complete", "?")])
N_NODES = 3


def write_slp(path, frames, tracks=("mouse_0", "mouse_1", "mouse_2"), n_frames=None, keypoints=None):
    """Write a minimal SLEAP-format file. frames[f] = list of source track ids per instance.
    Frames with no instances are omitted (as SLEAP does). keypoints(f, i) -> (N_NODES, 2)."""
    n_frames = len(frames) if n_frames is None else n_frames
    keypoints = keypoints or (lambda f, i: np.array([[f * 10.0 + i, n] for n in range(N_NODES)]))
    fr, ins, pts = [], [], []
    for f, row in enumerate(frames):
        if not row:
            continue
        start = len(ins)
        for i, t in enumerate(row):
            p0 = len(pts)
            for x, y in keypoints(f, i):
                pts.append((x, y, True, True, 1.0))
            ins.append((len(ins), 1, len(fr), 0, t, -1, 1.0, p0, len(pts), np.nan))
        fr.append((len(fr), 0, f, start, len(ins)))
    with h5py.File(path, "w") as h:
        h.create_dataset("frames", data=np.array(fr, dtype=FRAME_DT))
        h.create_dataset("instances", data=np.array(ins, dtype=INST_DT))
        h.create_dataset("pred_points", data=np.array(pts, dtype=PRED_DT))
        h.create_dataset("points", data=np.zeros(0, dtype=USER_DT))
        h.create_dataset("tracks_json", data=np.array([json.dumps([0, n], separators=(",", ":")).encode() for n in tracks]))
        v = {"filename": "x.mp4", "backend": {"type": "MediaVideo", "shape": [n_frames, 8, 8, 1], "fps": 50.0}}
        h.create_dataset("videos_json", data=np.array([json.dumps(v).encode()]))
        md = h.create_group("metadata")
        md.attrs["format_id"] = 1.4
        md.attrs["json"] = json.dumps({"version": "2.0.0", "nodes": [{"name": f"n{k}"} for k in range(N_NODES)],
                                       "skeletons": [], "tracks": [], "videos": []})
    return path


@pytest.fixture
def make_slp(tmp_path):
    def _make(name, frames, **kw):
        return write_slp(tmp_path / name, frames, **kw)
    return _make
