import json

import pytest
from fastapi.testclient import TestClient

from webgui_tools.identity import SCHEMA
from webgui_tools.server import create_app, load_config, pair_items, safe_name
from webgui_tools.slp import read_index

from conftest import write_slp

FRAMES = [[0, 1], [0, 1], [1, 0]]


@pytest.fixture
def setup(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    write_slp(data / "ID000.slp", FRAMES)
    (data / "ID000.mp4").write_bytes(bytes(range(256)) * 4)  # 1024 bytes stand-in
    (data / "notes.txt").write_text("not a clip")
    labels = tmp_path / "labels"
    client = TestClient(create_app({"labels_dir": labels, "datasets": {"b02": data, "gone": tmp_path / "missing"}}))
    return client, data, labels


def labels_for(data, events, updated=None):
    si = read_index(data / "ID000.slp")
    return {"schema": SCHEMA, "dataset": "b02", "stem": "ID000", "annotator": "renee", "updated": updated,
            "tracks": si.tracks, "events": events, "reviewed": [],
            "source": {"slp_name": "ID000.slp", "n_frames": si.n_frames, "n_instances": len(si.rows)}}


def test_pair_items_prefers_tracked():
    names = ["GT00.mp4", "GT00.predictions.slp", "GT00.tracked.slp", "ID10.mp4", "ID10.slp", "ID2.mp4", "ID2.slp", "lone.mp4"]
    assert [(i["stem"], i["slp"]) for i in pair_items(names)] == [
        ("GT00", "GT00.tracked.slp"), ("ID2", "ID2.slp"), ("ID10", "ID10.slp")]


def test_safe_name_matches_js_rule():
    assert safe_name(" Renee Chou ") == "Renee_Chou"
    assert safe_name("../../etc") == "_.._etc"
    assert safe_name("") == "anonymous"


def test_datasets_and_items(setup):
    client, _, _ = setup
    assert client.get("/api/datasets").json() == [{"name": "b02", "available": True}, {"name": "gone", "available": False}]
    items = client.get("/api/datasets/b02/items").json()
    assert [(i["stem"], i["mp4"], i["slp"], i["mp4_size"]) for i in items] == [("ID000", "ID000.mp4", "ID000.slp", 1024)]
    assert client.get("/api/datasets/gone/items").status_code == 503
    assert client.get("/api/datasets/nope/items").status_code == 404


def test_range_requests(setup):
    client, _, _ = setup
    r = client.get("/data/b02/ID000.mp4", headers={"Range": "bytes=10-19"})
    assert r.status_code == 206
    assert r.headers["content-range"] == "bytes 10-19/1024"
    assert r.content == bytes(range(10, 20))
    assert client.get("/data/b02/ID000.mp4", headers={"Range": "bytes=-4"}).content == bytes(range(252, 256))
    assert client.get("/data/b02/ID000.mp4", headers={"Range": "bytes=2000-"}).status_code == 416
    full = client.get("/data/b02/ID000.mp4")
    assert full.status_code == 200 and len(full.content) == 1024
    head = client.head("/data/b02/ID000.mp4")
    assert head.headers["content-length"] == "1024"


def test_only_clip_files_are_served(setup):
    client, _, _ = setup
    assert client.get("/data/b02/notes.txt").status_code == 404
    assert client.get("/data/b02/..%2F..%2Fetc%2Fpasswd").status_code == 404


def test_labels_save_load_and_conflict(setup):
    client, data, labels = setup
    url = "/api/labels/b02/ID000?annotator=renee"
    assert client.get(url).status_code == 404
    lab = labels_for(data, [{"kind": "map", "action": "swap", "f0": 2, "f1": None, "map": {"0": 1, "1": 0}}])
    r = client.put(url, json={"labels": lab, "log": {"changes": [{"op": "add"}]}})
    assert r.status_code == 200
    stamp = r.json()["updated"]
    assert client.get(url).json()["updated"] == stamp
    # stale base (another tab saved in between) -> 409, file untouched
    assert client.put(url, json={"labels": lab}).status_code == 409
    r2 = client.put(f"{url}&base={stamp}", json={"labels": lab, "log": {"snapshot": True}})
    assert r2.status_code == 200
    log = (labels / "b02" / "ID000" / "renee.log.jsonl").read_text().splitlines()
    assert len(log) == 2 and "labels" in json.loads(log[1]) and "labels" not in json.loads(log[0])
    assert client.get("/api/datasets/b02/status").json() == {
        "ID000": [{"annotator": "renee", "events": 1, "done": False, "updated": r2.json()["updated"]}]}


def test_labels_are_validated(setup):
    client, data, _ = setup
    lab = labels_for(data, [])
    assert client.put("/api/labels/b02/ID000?annotator=someone_else", json={"labels": lab}).status_code == 400
    assert client.put("/api/labels/b02/NOPE?annotator=renee", json={"labels": lab}).status_code == 404


def test_exports(setup):
    client, data, _ = setup
    lab = labels_for(data, [{"kind": "map", "action": "swap", "f0": 2, "f1": None, "map": {"0": 1, "1": 0}},
                            {"kind": "uncertain", "f0": 0, "f1": 2, "tracks": [0, 1], "resolved": "unsure", "note": "huddle"}])
    client.put("/api/labels/b02/ID000?annotator=renee", json={"labels": lab})
    r = client.get("/api/export/b02/ID000/corrected.slp?annotator=renee")
    assert r.status_code == 200 and r.content[:8] == b"\x89HDF\r\n\x1a\n"
    out = data.parent / "out.slp"
    out.write_bytes(r.content)
    assert list(read_index(out).index.track) == [0, 1, 0, 1, 0, 1]  # frame 2 [1,0] swapped back
    csv_text = client.get("/api/export/b02/ID000/uncertain_log.csv?annotator=renee").text
    assert csv_text.splitlines()[0] == "clip_id,frame_start,frame_end,what_happened,resolved"
    assert "cannot tell mouse_0, mouse_1: huddle" in csv_text
    assert client.get("/api/export/b02/ID000/corrected.slp?annotator=nobody").status_code == 404


def test_frontend_is_served(setup):
    client, _, _ = setup
    assert "<title>HCM Labeler</title>" in client.get("/").text
    js = client.get("/js/tasks/identity.js")
    assert js.status_code == 200 and js.headers["cache-control"] == "no-cache"


def test_config_refuses_labels_inside_data(tmp_path):
    (tmp_path / "data").mkdir()
    cfg = tmp_path / "config.toml"
    cfg.write_text('labels_dir = "data/labels"\n[datasets]\nb02 = "data"\n')
    with pytest.raises(SystemExit):
        load_config(cfg)
    cfg.write_text('labels_dir = "labels"\nport = 9000\n[datasets]\nb02 = "data"\n')
    c = load_config(cfg)
    assert c["port"] == 9000 and c["datasets"]["b02"] == (tmp_path / "data").resolve()
