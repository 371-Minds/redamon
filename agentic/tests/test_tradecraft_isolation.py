"""
Tier 3 / Stage 4: tradecraft scalar knobs (TRADECRAFT_FETCH_TIMEOUT,
TRADECRAFT_TIER2_THRESHOLD_BYTES, TRADECRAFT_DEFAULT_TTL_SEC) are read per
session at use-time from the task-isolated settings, exactly as
TradecraftLookupManager now does:  get_setting(KEY, self.<field>).

Reproduces the shared-mutation race and proves the use-time read isolates
concurrent sessions.
"""
import os
import asyncio
import unittest

os.environ.setdefault("WEBAPP_API_URL", "http://fake-webapp")
import project_settings as ps


class TestTradecraftScalarIsolation(unittest.TestCase):
    def setUp(self):
        self._orig = ps.fetch_agent_settings
        ps._settings = None
        ps._settings_ctx.set(None)

        def _fetch(project_id, webapp_url):
            s = dict(ps.DEFAULT_AGENT_SETTINGS)
            s["TRADECRAFT_FETCH_TIMEOUT"] = {"PA": 10, "PB": 45}[project_id]
            return s
        ps.fetch_agent_settings = _fetch

    def tearDown(self):
        ps.fetch_agent_settings = self._orig
        ps._settings = None
        ps._settings_ctx.set(None)

    def test_before_contaminates_after_isolates(self):
        # ONE shared manager whose fetch_timeout is the construction baseline.
        shared_mgr_fetch_timeout = 30
        before, after = {}, {}
        barrier = asyncio.Barrier(2)

        async def sess(pid, label, baseline):
            ps.load_project_settings(pid)
            # BEFORE: apply stamped the per-project value onto the shared manager.
            baseline["v"] = ps.get_setting("TRADECRAFT_FETCH_TIMEOUT")
            await barrier.wait()
            before[label] = baseline["v"]  # shared -> last writer
            # AFTER: read at use-time from task-isolated settings.
            after[label] = ps.get_setting("TRADECRAFT_FETCH_TIMEOUT", shared_mgr_fetch_timeout)

        shared = {"v": shared_mgr_fetch_timeout}

        async def main():
            await asyncio.gather(sess("PA", "A", shared), sess("PB", "B", shared))

        asyncio.run(main())
        self.assertEqual(before["A"], before["B"])   # contaminated (shared)
        self.assertEqual(after["A"], 10)             # isolated
        self.assertEqual(after["B"], 45)


if __name__ == "__main__":
    unittest.main(verbosity=2)
