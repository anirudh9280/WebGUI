"""Transcode clips to browser-decodable H.264 for Web_GUI, keeping every frame.

Leo's batch-02 clips are MPEG-4 Part 2 (mp4v), which browsers cannot decode. Output is
H.264 yuv420p, no B-frames (decode order == display order), a keyframe every --gop
frames (bounds seek cost), +faststart. The frame count is checked against the input.
Matching .slp files are copied next to the output so the folder is a ready dataset.

    uv run python -m webgui_tools.transcode OUT_DIR IN.mp4 [IN2.mp4 ...]
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def count_frames(path):
    return imageio_ffmpeg.count_frames_and_secs(str(path))[0]


def transcode(src, dst, crf=18, gop=50, preset="fast"):
    tmp = dst.with_suffix(".part.mp4")
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
           "-map", "0:v:0", "-an", "-fps_mode", "passthrough",
           "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
           "-bf", "0", "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
           "-movflags", "+faststart", str(tmp)]
    subprocess.run(cmd, check=True)
    n_in, n_out = count_frames(src), count_frames(tmp)
    if n_in != n_out:
        tmp.unlink()
        raise RuntimeError(f"{src.name}: frame count changed {n_in} -> {n_out}")
    tmp.replace(dst)
    return n_out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("inputs", nargs="+", type=Path)
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--gop", type=int, default=50)
    ap.add_argument("--no-slp", action="store_true", help="don't copy the matching .slp")
    a = ap.parse_args(argv)
    a.out_dir.mkdir(parents=True, exist_ok=True)
    for src in a.inputs:
        dst = a.out_dir / (src.stem + ".mp4")
        if dst.exists():
            print(f"skip {dst} (exists)")
        else:
            n = transcode(src, dst, crf=a.crf, gop=a.gop)
            print(f"{src.name} -> {dst} ({n} frames, {dst.stat().st_size / 1e6:.0f} MB)", flush=True)
        slp = src.with_suffix(".slp")
        if not a.no_slp and slp.exists() and not (a.out_dir / slp.name).exists():
            shutil.copyfile(slp, a.out_dir / slp.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
