"""
Tier 3 / Stage 3: Knowledge-Base config is isolated per session (read at
use-time from task-isolated settings) instead of mutated onto the shared KB
instance. Two checks:

  1. PentestKnowledgeBase.query() honors per-call knob overrides (and falls back
     to the instance value when the override is None) -- backward compatible.
  2. Concurrent sessions resolve their OWN KB knob values (the web_search
     closure's _kb_knob resolution), reproducing the shared-mutation race on the
     old read pattern and proving the new use-time read is isolated.

Pure unittest (no pytest); runs in the agent container.
"""
import os
import types
import asyncio
import unittest
from unittest.mock import MagicMock

os.environ.setdefault("WEBAPP_API_URL", "http://fake-webapp")

from knowledge_base.kb_orchestrator import PentestKnowledgeBase
import project_settings as ps


def _fake_kb_self(**overrides):
    faiss = MagicMock()
    faiss.count.return_value = 2
    faiss.search.return_value = []          # empty -> query returns [] after search
    embedder = MagicMock()
    embedder.embed_query.return_value = [0.1, 0.2, 0.3]
    ns = types.SimpleNamespace(
        faiss=faiss, embedder=embedder,
        rerank_enabled=False, rerank_pool_size=0,
        fulltext_enabled=False, neo4j=None,
        top_k=8, overfetch_factor=2, mmr_enabled=False, mmr_lambda=0.5,
        score_threshold=0.7, source_boosts={},
    )
    for k, v in overrides.items():
        setattr(ns, k, v)
    return ns


class TestKBQueryOverrides(unittest.TestCase):
    def _search_top_k(self, fake_self):
        # candidate_pool_size is passed as faiss.search(query_vector, top_k=...)
        _, kwargs = fake_self.faiss.search.call_args
        return kwargs.get("top_k")

    def test_overfetch_override_is_honored(self):
        s = _fake_kb_self(overfetch_factor=2)
        PentestKnowledgeBase.query(s, "q", top_k=5, overfetch_factor=3)
        # candidate_pool_size = max(k*_overfetch, 0) = 5 * 3 (override) = 15
        self.assertEqual(self._search_top_k(s), 15)

    def test_overfetch_falls_back_to_instance_when_unset(self):
        s = _fake_kb_self(overfetch_factor=2)
        PentestKnowledgeBase.query(s, "q", top_k=5)  # no override
        self.assertEqual(self._search_top_k(s), 10)  # 5 * self.overfetch_factor(2)

    def test_new_kwargs_accepted_without_error(self):
        s = _fake_kb_self()
        # Passing all new per-call knobs must not raise (backward compatible).
        out = PentestKnowledgeBase.query(
            s, "q", top_k=4, overfetch_factor=2,
            mmr_enabled=True, mmr_lambda=0.3, source_boosts={"owasp": 2.0},
        )
        self.assertEqual(out, [])


class TestKBConfigConcurrencyIsolation(unittest.TestCase):
    """Reproduce the shared-mutation race (BEFORE) and prove the use-time read
    (AFTER) isolates concurrent sessions, using the exact _kb_knob resolution."""

    def setUp(self):
        self._orig = ps.fetch_agent_settings
        ps._settings = None
        ps._settings_ctx.set(None)

        def _fetch(project_id, webapp_url):
            s = dict(ps.DEFAULT_AGENT_SETTINGS)
            s["KB_TOP_K"] = {"PA": 3, "PB": 15}[project_id]
            return s
        ps.fetch_agent_settings = _fetch

    def tearDown(self):
        ps.fetch_agent_settings = self._orig
        ps._settings = None
        ps._settings_ctx.set(None)

    def test_before_contaminates_after_isolates(self):
        shared_kb = types.SimpleNamespace(top_k=8)  # ONE shared instance

        def _kb_knob(key, attr):  # the web_search closure's resolution
            v = ps.get_setting(key, None)
            return v if v is not None else getattr(shared_kb, attr, None)

        before, after = {}, {}
        barrier = asyncio.Barrier(2)

        async def sess(pid, label):
            ps.load_project_settings(pid)
            shared_kb.top_k = ps.get_setting("KB_TOP_K")  # BEFORE: mutate shared
            await barrier.wait()
            before[label] = shared_kb.top_k                 # BEFORE read site
            after[label] = _kb_knob("KB_TOP_K", "top_k")    # AFTER read site

        async def main():
            await asyncio.gather(sess("PA", "A"), sess("PB", "B"))

        asyncio.run(main())
        # BEFORE: both read the last writer -> contaminated (identical)
        self.assertEqual(before["A"], before["B"])
        # AFTER: each reads its own project value -> isolated
        self.assertEqual(after["A"], 3)
        self.assertEqual(after["B"], 15)


if __name__ == "__main__":
    unittest.main(verbosity=2)
