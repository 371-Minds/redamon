"""Cross-language contract: ExploitTree.to_view() must emit exactly the fields
the TS UI reads (LatsNodeView / LatsTreeSnapshot in websocket-types.ts). A
field-name drift renders as `undefined` in the UI with NO error, so this test
parses the TS interfaces and asserts key-set parity in both directions.
"""

from __future__ import annotations

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from state import ExploitTree, ExploitTreeNode  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TS_TYPES = os.path.join(REPO_ROOT, "webapp", "src", "lib", "websocket-types.ts")


def _ts_interface_fields(name: str) -> set:
    """Extract top-level field names from `export interface <name> { ... }`."""
    with open(TS_TYPES, "r") as f:
        src = f.read()
    m = re.search(rf"export interface {name} \{{(.*?)\n\}}", src, re.S)
    if not m:
        raise AssertionError(f"interface {name} not found in {TS_TYPES}")
    body = m.group(1)
    fields = set()
    depth = 0
    for line in body.splitlines():
        stripped = line.strip()
        # Only capture fields at brace-depth 0 (skip nested object literals).
        if depth == 0:
            fm = re.match(r"([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:", stripped)
            if fm:
                fields.add(fm.group(1))
        depth += stripped.count("{") - stripped.count("}")
    return fields


def _sample_view() -> dict:
    root = ExploitTreeNode(id="root", status="evaluated")
    child = ExploitTreeNode(id="c1", parent_id="root", depth=1, tool_name="execute_curl",
                            tool_args={"url": "x"}, value=0.8)
    root.children = ["c1"]
    tree = ExploitTree(root_id="root", nodes={"root": root, "c1": child}, objective="o")
    return tree.to_view(search_id="s:root", phase="exploitation", shadow_mode=True,
                        max_rollouts=24, max_depth=6, best_trajectory=["root", "c1"])


class TestViewContract(unittest.TestCase):
    def test_snapshot_keys_match_ts(self):
        view = _sample_view()
        py_keys = set(view.keys())
        ts_keys = _ts_interface_fields("LatsTreeSnapshot")
        self.assertEqual(py_keys, ts_keys,
                         f"snapshot drift: py-only={py_keys - ts_keys}, ts-only={ts_keys - py_keys}")

    def test_node_keys_match_ts(self):
        view = _sample_view()
        self.assertTrue(view["nodes"])
        py_keys = set(view["nodes"][0].keys())
        ts_keys = _ts_interface_fields("LatsNodeView")
        self.assertEqual(py_keys, ts_keys,
                         f"node drift: py-only={py_keys - ts_keys}, ts-only={ts_keys - py_keys}")

    def test_budget_shape(self):
        view = _sample_view()
        self.assertEqual(set(view["budget"].keys()), {"max_rollouts", "max_depth"})


if __name__ == "__main__":
    unittest.main()
