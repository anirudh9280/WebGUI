import json
from pathlib import Path

import pytest

from webgui_tools.identity import apply_events, index_from_lists

CASES = json.loads((Path(__file__).parents[2] / "tests/fixtures/identity_cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_fixture(case):
    index = index_from_lists(case["frames"])
    track, deleted = apply_events(index, case["events"])
    got = []
    for f in range(index.n_frames):
        a, b = index.frame_start[f], index.frame_start[f + 1]
        got.append([None if deleted[k] else int(track[k]) for k in range(a, b)])
    assert got == case["expected"]
