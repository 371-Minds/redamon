"""Step 3 — LATS streaming emission + the dual-enum string contract.

Drives lats_hook in shadow mode with a fake StreamingCallback and asserts
on_lats_start / on_lats_tree_update fire with a schema-valid snapshot; asserts
the Python MessageType.LATS_* string literals match the TS enum contract
(webapp/src/lib/websocket-types.ts). See LATS_integration.md §19 Step 3.
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402


def _settings(**over):
    s = dict(project_settings.DEFAULT_AGENT_SETTINGS)
    s["LATS_ENABLED"] = True
    s["LATS_SHADOW_MODE"] = True
    s.update(over)
    return s


def _state():
    return {
        "current_phase": "exploitation",
        "session_id": "s1",
        "target_info": {"services": ["http"]},
        "chain_findings_memory": [],
        "conversation_objectives": [{"objective": "admin takeover"}],
        "current_objective_index": 0,
        "deep_think_ran_this_turn": True,
        "_reject_tool": False,
        "_current_plan": None,
        "_current_step": None,
        "_exploit_tree": None,
    }


def _decision():
    return {"action": "use_tool", "tool_name": "execute_nmap", "tool_args": {},
            "output_analysis": {"per_step": [], "productivity": {"verdict": "new_info"}}}


TWO_PROBES = [
    {"tool_name": "execute_curl", "tool_args": {"url": "a"}, "rationale": "sqli"},
    {"tool_name": "execute_httpx", "tool_args": {"url": "b"}, "rationale": "enum"},
]


class _FakeCallback:
    def __init__(self):
        self.starts = []
        self.updates = []
        self.completes = []

    async def on_lats_start(self, search_id, objective, phase, budget, shadow_mode):
        self.starts.append({"search_id": search_id, "objective": objective,
                            "phase": phase, "budget": budget, "shadow_mode": shadow_mode})

    async def on_lats_tree_update(self, search_id, snapshot):
        self.updates.append({"search_id": search_id, "snapshot": snapshot})

    async def on_lats_complete(self, search_id, best_trajectory, outcome, metrics=None):
        self.completes.append({"search_id": search_id, "outcome": outcome,
                               "best_trajectory": best_trajectory, "metrics": metrics})


class TestEmission(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    async def test_start_and_update_emitted_with_valid_snapshot(self):
        cb = _FakeCallback()
        callbacks = {"s1": cb}
        state = _state()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=TWO_PROBES)):
            await lats.lats_hook(state, _decision(), llm=object(),
                                 streaming_callbacks=callbacks, session_id="s1")
        # on_lats_start fired once
        self.assertEqual(len(cb.starts), 1)
        self.assertEqual(cb.starts[0]["phase"], "exploitation")
        self.assertTrue(cb.starts[0]["shadow_mode"])
        self.assertEqual(cb.starts[0]["budget"]["max_rollouts"], 24)
        # on_lats_tree_update fired with a schema-valid snapshot
        self.assertEqual(len(cb.updates), 1)
        snap = cb.updates[0]["snapshot"]
        for key in ("search_id", "objective", "phase", "shadow_mode", "rollouts",
                    "budget", "active_id", "best_trajectory", "nodes"):
            self.assertIn(key, snap)
        self.assertTrue(snap["search_id"].startswith("s1:"))
        # each node view carries the documented fields
        self.assertTrue(snap["nodes"])
        n = snap["nodes"][0]
        for key in ("id", "parent_id", "depth", "label", "tool_name", "status",
                    "value", "local_value", "visits", "verdict", "error_class",
                    "finding_confidence", "exploit_succeeded", "observation",
                    "reflection", "is_dangerous", "step_id"):
            self.assertIn(key, n)

    async def test_no_callback_is_safe(self):
        state = _state()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=TWO_PROBES)):
            # streaming_callbacks=None must not raise
            out = await lats.lats_hook(state, _decision(), llm=object(),
                                       streaming_callbacks=None, session_id="s1")
        self.assertIsNotNone(state["_exploit_tree"])
        self.assertEqual(out["action"], "use_tool")


class TestMsgTypeContract(unittest.TestCase):
    def test_lats_string_literals(self):
        from websocket_api import MessageType
        # These literals MUST equal the TS MessageType enum values.
        self.assertEqual(MessageType.LATS_START.value, "lats_start")
        self.assertEqual(MessageType.LATS_TREE_UPDATE.value, "lats_tree_update")
        self.assertEqual(MessageType.LATS_COMPLETE.value, "lats_complete")


if __name__ == "__main__":
    unittest.main()
