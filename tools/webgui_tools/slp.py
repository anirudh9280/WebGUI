"""Minimal read access to SLEAP .slp (HDF5) files: the per-frame instance table."""
import json
from dataclasses import dataclass

import h5py
import numpy as np

from .identity import Index


@dataclass
class SlpIndex:
    index: Index
    rows: np.ndarray  # instances-table row for each index position
    tracks: list  # track names, by track id
    n_frames: int
    fps: float


def _video_meta(f):
    v = json.loads(f["videos_json"][0])
    shape = v.get("backend", {}).get("shape")
    return (shape[0] if shape else None), v.get("backend", {}).get("fps")


def track_names(f):
    return [json.loads(t)[1] for t in f["tracks_json"][:]]


def read_index(path):
    with h5py.File(path, "r") as f:
        frames = f["frames"][:]
        inst = f["instances"][:]
        tracks = track_names(f)
        n_frames, fps = _video_meta(f)
    frames = frames[frames["video"] == 0]
    frames = frames[np.argsort(frames["frame_idx"], kind="stable")]
    if n_frames is None:
        n_frames = int(frames["frame_idx"].max()) + 1 if len(frames) else 0
    counts = np.zeros(n_frames, dtype=np.int64)
    rows = []
    for fr in frames:
        a, b = int(fr["instance_id_start"]), int(fr["instance_id_end"])
        counts[fr["frame_idx"]] += b - a
        rows.extend(range(a, b))
    rows = np.array(rows, dtype=np.int64)
    frame_start = np.zeros(n_frames + 1, dtype=np.int64)
    frame_start[1:] = np.cumsum(counts)
    track = inst["track"][rows].astype(np.int16)
    return SlpIndex(Index(n_frames, frame_start, track), rows, tracks, n_frames, fps or 0.0)


def instance_keys(path):
    """(frame_idx, rounded keypoint bytes) per instances-table row, for matching across files."""
    with h5py.File(path, "r") as f:
        frames = f["frames"][:]
        inst = f["instances"][:]
        pred = f["pred_points"][:]
        user = f["points"][:]
    fidx = np.empty(len(inst), dtype=np.int64)
    for fr in frames:
        fidx[fr["instance_id_start"]:fr["instance_id_end"]] = fr["frame_idx"]
    keys = []
    for r, row in enumerate(inst):
        pts = pred if row["instance_type"] == 1 else user
        p = pts[row["point_id_start"]:row["point_id_end"]]
        xy = np.round(np.nan_to_num(np.stack([p["x"], p["y"]]), nan=-1.0), 3)
        keys.append((int(fidx[r]), xy.tobytes()))
    return keys
