"""HTTP Request Smuggling (desync) built-in attack skill.

Verifies the new `http_request_smuggling` class is wired end-to-end (enabled by
default, classifiable, workflow builds) and, importantly, that it stays a GENERAL
methodology with NO benchmark-specific content (fairness: the agent must discover
the target itself; the skill only supplies standard technique).
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings as ps  # noqa: E402
from prompts import build_builtin_skill_workflow, HTTP_SMUGGLING_TOOLS  # noqa: E402
from prompts.classification import build_skill_menu, _CLASSIFICATION_INSTRUCTIONS  # noqa: E402
from prompts.base import build_attack_path_behavior  # noqa: E402

CLS = "http_request_smuggling"


class TestHrsWiring(unittest.TestCase):
    def test_enabled_by_default(self):
        self.assertIs(
            ps.DEFAULT_AGENT_SETTINGS["ATTACK_SKILL_CONFIG"]["builtIn"][CLS], True)

    def test_workflow_builds_with_key_steps(self):
        wf = build_builtin_skill_workflow(CLS, {"execute_code", "execute_curl", "kali_shell"})
        blob = "\n".join(wf)
        self.assertTrue(wf)
        for token in ("SMUGGLING", "CL.TE", "TE.CL", "desync", "Transfer-Encoding"):
            self.assertIn(token, blob, token)

    def test_workflow_requires_execute_code(self):
        # smuggling needs raw byte control -> gated on execute_code
        self.assertEqual(build_builtin_skill_workflow(CLS, {"execute_curl"}), [])

    def test_tooling_steers_to_raw_sockets(self):
        self.assertIn("execute_code", HTTP_SMUGGLING_TOOLS)
        self.assertIn("raw socket", HTTP_SMUGGLING_TOOLS)

    def test_menu_lists_and_classifies_hrs(self):
        menu = build_skill_menu({CLS}, [])
        self.assertIn(CLS, menu)
        self.assertIn(CLS, _CLASSIFICATION_INSTRUCTIONS)
        for token in ("proxy", "Transfer-Encoding", "Content-Length"):
            self.assertIn(token, _CLASSIFICATION_INSTRUCTIONS[CLS])

    def test_behavior_blurb_present(self):
        self.assertIn("raw socket", build_attack_path_behavior(CLS))


class TestHrsFairnessAndStyle(unittest.TestCase):
    """The skill must be GENERAL: no target/benchmark-specific hints, no em dashes."""

    def test_no_em_dash_in_workflow(self):
        self.assertNotIn("—", HTTP_SMUGGLING_TOOLS)

    def test_no_benchmark_specific_leak(self):
        blob = (HTTP_SMUGGLING_TOOLS + _CLASSIFICATION_INSTRUCTIONS[CLS]
                + build_attack_path_behavior(CLS)).lower()
        # nothing that would reveal a specific target's solution
        for leak in ("mitmproxy", "haproxy", "lab-", "xben", "/devices", "/admin_panel",
                     "hrs_admin_router", "flag{"):
            self.assertNotIn(leak, blob, f"benchmark-specific leak: {leak}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
