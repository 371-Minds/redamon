"""Regression tests for LATS wave attribution correctness (bugs found in the
deep review):

- Bug 2: an aggregate wave-level exploit_succeeded / finding must NOT mark every
  sibling terminal / inflate every sibling's value. Only the localized (per_step)
  or single credited child wins.
- Bug 3: an executing child that never ran (no matching executed step) must be
  reset to 'proposed' so it is re-selected, and must not steal another wave's
  step via positional skew (attribution is by tool_name).
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402
from state import ExploitTree, ExploitTreeNode  # noqa: E402


def _tree(children):
    """children: list of (id, tool_name). All start 'executing' under root."""
    root = ExploitTreeNode(id="root", status="evaluated", depth=0)
    tree = ExploitTree(root_id="root", nodes={"root": root})
    for cid, tool in children:
        n = ExploitTreeNode(id=cid, parent_id="root", depth=1, status="executing",
                            tool_name=tool)
        tree.nodes[cid] = n
        root.children.append(cid)
    return tree


def _plan(*steps):
    return {"steps": list(steps)}


def _step(tool_name, tool_output="200 ok", error_class="success"):
    return {"tool_name": tool_name, "tool_output": tool_output, "error_class": error_class,
            "duration_ms": 100, "step_id": f"s-{tool_name}"}


class TestAggregateExploitNotOverCredited(unittest.TestCase):
    def setUp(self):
        project_settings._settings = None

    def tearDown(self):
        project_settings._settings = None

    def test_aggregate_success_marks_only_one_terminal(self):
        tree = _tree([("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl"), _step("execute_httpx"))}
        # aggregate says a foothold happened, but NO per_step localizes which probe
        analysis = {"exploit_succeeded": True, "per_step": [],
                    "productivity": {"verdict": "new_info"}}
        lats._evaluate_wave(tree, state, analysis)
        terminals = [n for n in tree.nodes.values() if n.status == "terminal"]
        self.assertEqual(len(terminals), 1, "exactly one child may be credited the win")

    def test_per_step_localizes_the_win(self):
        tree = _tree([("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl", "403 blocked", "application_4xx"),
                                        _step("execute_httpx", "reset admin ok"))}
        analysis = {"exploit_succeeded": True, "per_step": [
            {"step_index": 0, "verdict": "blocked"},
            {"step_index": 1, "verdict": "new_info", "exploit_succeeded": True},
        ]}
        lats._evaluate_wave(tree, state, analysis)
        self.assertEqual(tree.nodes["c2"].status, "terminal")
        self.assertNotEqual(tree.nodes["c1"].status, "terminal")

    def test_aggregate_finding_not_credited_to_every_sibling(self):
        tree = _tree([("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl"), _step("execute_httpx"))}
        analysis = {"exploit_succeeded": False,
                    "chain_findings": [{"confidence": 90}], "per_step": [],
                    "productivity": {"verdict": "new_info"}}
        lats._evaluate_wave(tree, state, analysis)
        credited = [n for n in (tree.nodes["c1"], tree.nodes["c2"]) if n.finding_confidence_delta > 0]
        self.assertEqual(len(credited), 1, "aggregate finding credited to exactly one child")


class TestNeverRanChildrenReset(unittest.TestCase):
    def setUp(self):
        project_settings._settings = None

    def tearDown(self):
        project_settings._settings = None

    def test_unmatched_child_reset_to_proposed(self):
        # c2 (execute_httpx) never ran this turn -> reset to proposed, re-selectable.
        tree = _tree([("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl"))}
        analysis = {"exploit_succeeded": False, "per_step": [], "productivity": {"verdict": "new_info"}}
        lats._evaluate_wave(tree, state, analysis)
        self.assertEqual(tree.nodes["c1"].status, "evaluated")
        self.assertEqual(tree.nodes["c2"].status, "proposed")

    def test_stranded_child_does_not_steal_another_waves_step(self):
        # A leftover executing child from a prior wave (metasploit) plus the new
        # wave [curl, httpx]. tool_name matching must pair curl<->curl and
        # httpx<->httpx, and reset the stranded metasploit child, with NO skew.
        tree = _tree([("stray", "metasploit_console"),
                      ("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl", "curl-out", "application_4xx"),
                                        _step("execute_httpx", "httpx-out", "success"))}
        analysis = {"exploit_succeeded": False, "per_step": [], "productivity": {"verdict": "new_info"}}
        lats._evaluate_wave(tree, state, analysis)
        self.assertEqual(tree.nodes["stray"].status, "proposed")     # reset, not stranded
        self.assertEqual(tree.nodes["c1"].error_class, "application_4xx")  # got ITS OWN step
        self.assertEqual(tree.nodes["c2"].error_class, "success")
        self.assertEqual(tree.nodes["c1"].observation_summary[:4], "curl")
        self.assertIn("httpx", tree.nodes["c2"].observation_summary)


if __name__ == "__main__":
    unittest.main()
