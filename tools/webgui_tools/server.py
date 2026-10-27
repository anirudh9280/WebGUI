"""Web_GUI lab server: serves the labeler, the clips (read-only, with HTTP Range), and saves
labels. Exports run here too, so annotators only ever need a browser.

    uv run python -m webgui_tools.server --config ../config.toml

Config (TOML, see config.example.toml):
    host = "0.0.0.0"
    port = 8770
    labels_dir = "/home/exx/vast/anirudh/web_gui/labels"   # the only place the server writes
    [datasets]
    batch02_identity = "/home/exx/vast/anirudh/web_gui/data/batch02_identity"
"""
import argparse
import csv
import io
import json
import os
import re
import tempfile
import threading
import tomllib
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .export import export_slp, uncertain_log_rows

APP_ROOT = Path(__file__).resolve().parents[2]  # Web_GUI/
SLP_PREFERENCE = (".tracked.slp", ".slp", ".predictions.slp")
CHUNK = 1 << 20


def safe_name(s):
    """Same rule as safeName in js/core/labels.js."""
    s = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(s).strip()).lstrip(".")
    return s or "anonymous"


def pair_items(names):
    """Same rule as pairItems in js/core/datasets.js: <stem>.mp4 + best matching .slp."""
    names = set(names)
    items = []
    for mp4 in names:
        if not mp4.lower().endswith(".mp4") or mp4.startswith("."):
            continue
        stem = mp4[:-4]
        slp = next((stem + suf for suf in SLP_PREFERENCE if stem + suf in names), None)
        if slp:
            items.append({"stem": stem, "mp4": mp4, "slp": slp})
    key = lambda it: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", it["stem"])]  # noqa: E731
    return sorted(items, key=key)


def load_config(path):
    with open(path, "rb") as fh:
        cfg = tomllib.load(fh)
    base = Path(path).resolve().parent
    labels = (base / cfg["labels_dir"]).resolve()
    datasets = {name: (base / p).resolve() for name, p in cfg.get("datasets", {}).items()}
    for name, root in datasets.items():
        if labels == root or root in labels.parents:
            raise SystemExit(f"labels_dir must not be inside dataset {name!r}: data folders are read-only")
    return {"host": cfg.get("host", "127.0.0.1"), "port": int(cfg.get("port", 8770)),
            "labels_dir": labels, "datasets": datasets}


def create_app(cfg):
    labels_dir = Path(cfg["labels_dir"])
    labels_dir.mkdir(parents=True, exist_ok=True)
    datasets = {k: Path(v) for k, v in cfg["datasets"].items()}
    write_lock = threading.Lock()
    app = FastAPI(title="HCM Labeler", docs_url="/api/docs", openapi_url="/api/openapi.json")

    def dataset_root(ds):
        if ds not in datasets:
            raise HTTPException(404, f"unknown dataset {ds!r}")
        if not datasets[ds].is_dir():
            raise HTTPException(503, f"dataset folder for {ds!r} is not reachable on the server")
        return datasets[ds]

    def items(ds):
        return pair_items(os.listdir(dataset_root(ds)))

    def item(ds, stem):
        it = next((x for x in items(ds) if x["stem"] == stem), None)
        if not it:
            raise HTTPException(404, f"no clip {stem!r} in {ds!r}")
        return it

    def label_path(ds, stem, annotator):
        item(ds, stem)  # stem must be a real clip: no arbitrary paths
        return labels_dir / safe_name(ds) / safe_name(stem) / f"{safe_name(annotator)}.json"

    def read_labels(path):
        try:
            return json.loads(path.read_text())
        except FileNotFoundError:
            return None

    @app.get("/api/datasets")
    def list_datasets():
        return [{"name": k, "available": v.is_dir()} for k, v in datasets.items()]

    @app.get("/api/datasets/{ds}/items")
    def list_items(ds: str):
        root = dataset_root(ds)
        return [{**it, "mp4_size": (root / it["mp4"]).stat().st_size} for it in items(ds)]

    @app.get("/api/datasets/{ds}/status")
    def status(ds: str):
        out = {}
        d = labels_dir / safe_name(ds)
        if d.is_dir():
            for f in sorted(d.glob("*/*.json")):
                try:
                    lab = json.loads(f.read_text())
                except (OSError, ValueError):
                    continue
                out.setdefault(f.parent.name, []).append({"annotator": lab.get("annotator"), "events": len(lab.get("events", [])),
                                                         "done": bool(lab.get("done")), "updated": lab.get("updated")})
        return out

    @app.api_route("/data/{ds}/{name}", methods=["GET", "HEAD"])
    def data_file(ds: str, name: str, request: Request):
        it = next((x for x in items(ds) if name in (x["mp4"], x["slp"])), None)
        if not it:
            raise HTTPException(404, "not a clip file")
        path = dataset_root(ds) / name
        size = path.stat().st_size
        ctype = "video/mp4" if name.lower().endswith(".mp4") else "application/octet-stream"
        headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"}
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", request.headers.get("range", ""))
        if request.method == "HEAD":
            return Response(headers={**headers, "Content-Length": str(size), "Content-Type": ctype})
        if not m or (not m.group(1) and not m.group(2)):
            return FileResponse(path, media_type=ctype, headers=headers)
        if m.group(1):
            start = int(m.group(1))
            end = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
        else:  # suffix range: last N bytes
            start, end = max(0, size - int(m.group(2))), size - 1
        if start > end or start >= size:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

        def body():
            with open(path, "rb") as fh:
                fh.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = fh.read(min(left, CHUNK))
                    if not chunk:
                        break
                    left -= len(chunk)
                    yield chunk

        return StreamingResponse(body(), status_code=206, media_type=ctype, headers={
            **headers, "Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(end - start + 1)})

    @app.get("/api/labels/{ds}/{stem}")
    def get_labels(ds: str, stem: str, annotator: str = Query(...)):
        lab = read_labels(label_path(ds, stem, annotator))
        if lab is None:
            raise HTTPException(404, "no labels yet")
        return lab

    @app.put("/api/labels/{ds}/{stem}")
    def put_labels(ds: str, stem: str, annotator: str = Query(...), base: str | None = Query(None),
                   payload: dict = Body(...)):
        """Save labels. `base` is the `updated` stamp the client last saw (absent for a new file);
        if the file has changed since (another tab/device), answer 409 instead of overwriting."""
        path = label_path(ds, stem, annotator)
        labels, log = payload.get("labels"), payload.get("log") or {}
        if not isinstance(labels, dict) or labels.get("stem") != stem or labels.get("dataset") != ds:
            raise HTTPException(400, "labels don't match this clip")
        if safe_name(labels.get("annotator", "")) != safe_name(annotator):
            raise HTTPException(400, "labels belong to a different annotator")
        with write_lock:
            current = read_labels(path)
            if (current or {}).get("updated") != (base or None):
                return JSONResponse({"detail": "changed elsewhere", "current": current}, status_code=409)
            labels["updated"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(labels, indent=1))
            os.replace(tmp, path)
            entry = {"at": labels["updated"], **log}
            if log.get("snapshot"):
                entry["labels"] = labels
            with open(path.with_suffix(".log.jsonl"), "a") as fh:
                fh.write(json.dumps(entry) + "\n")
        return {"updated": labels["updated"]}

    def saved_labels(ds, stem, annotator):
        lab = read_labels(label_path(ds, stem, annotator))
        if lab is None:
            raise HTTPException(404, f"{annotator} has no saved labels for {stem}")
        return lab

    @app.get("/api/export/{ds}/{stem}/corrected.slp")
    def export_corrected(ds: str, stem: str, annotator: str = Query(...)):
        lab = saved_labels(ds, stem, annotator)
        src = dataset_root(ds) / item(ds, stem)["slp"]
        fd, out = tempfile.mkstemp(suffix=".slp")
        os.close(fd)
        try:
            export_slp(lab, src, out)
        except ValueError as e:
            os.unlink(out)
            raise HTTPException(409, str(e))
        data = Path(out).read_bytes()
        os.unlink(out)
        return Response(data, media_type="application/octet-stream", headers={
            "Content-Disposition": f'attachment; filename="{stem}.{safe_name(annotator)}.corrected.slp"'})

    @app.get("/api/export/{ds}/{stem}/uncertain_log.csv")
    def export_log(ds: str, stem: str, annotator: str = Query(...)):
        lab = saved_labels(ds, stem, annotator)
        buf = io.StringIO()
        csv.writer(buf, lineterminator="\n").writerows(uncertain_log_rows(lab, stem, lab["source"]["n_frames"]))
        return Response(buf.getvalue(), media_type="text/csv", headers={
            "Content-Disposition": f'attachment; filename="{stem}_uncertain_log_{safe_name(annotator)}.csv"'})

    @app.get("/")
    def index():
        return FileResponse(APP_ROOT / "index.html", headers={"Cache-Control": "no-cache"})

    @app.middleware("http")
    async def revalidate_frontend(request, call_next):
        # Without this, browsers may pair a new index.html with stale cached modules after an update.
        response = await call_next(request)
        if request.url.path.startswith(("/js/", "/css/", "/vendor/")):
            response.headers["Cache-Control"] = "no-cache"
        return response

    for sub in ("js", "css", "vendor"):
        app.mount(f"/{sub}", StaticFiles(directory=APP_ROOT / sub), name=sub)
    return app


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(APP_ROOT / "config.toml"))
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    a = ap.parse_args(argv)
    cfg = load_config(a.config)
    import uvicorn

    host, port = a.host or cfg["host"], a.port or cfg["port"]
    print(f"labels -> {cfg['labels_dir']}")
    for name, root in cfg["datasets"].items():
        print(f"dataset {name} -> {root}{'' if root.is_dir() else '  (NOT FOUND)'}")
    uvicorn.run(create_app(cfg), host=host, port=port)


if __name__ == "__main__":
    main()
