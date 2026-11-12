import unittest
from datetime import datetime
from live_pricing import flash_cost

class PricingTests(unittest.TestCase):
    def test_peak_boundaries_and_holiday(self):
        usage={'prompt_cache_hit_tokens':1000000,'prompt_cache_miss_tokens':1000000,
               'prompt_tokens':2000000,'completion_tokens':1000000,'total_tokens':3000000}
        for stamp,expected in [('2026-11-06T09:00:00+08:00',10.04),
                               ('2026-11-06T12:00:00+08:00',5.02),
                               ('2026-11-06T14:00:00+08:00',10.04),
                               ('2026-11-06T18:00:00+08:00',5.02),
                               ('2026-11-07T10:00:00+08:00',5.02),
                               ('2026-10-01T10:00:00+08:00',5.02)]:
            self.assertEqual(flash_cost(usage,datetime.fromisoformat(stamp).timestamp())['nanoYuan']/1e9,expected)
        self.assertIsNone(flash_cost(usage,datetime.fromisoformat('2027-01-01T10:00:00+08:00').timestamp()))
        self.assertIsNone(flash_cost({'total_tokens':5},datetime.now().timestamp()))

    def test_persisted_cost_is_not_repriced_on_restart(self):
        from live_ledger import LiveLedger
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'ledger.db';ledger=LiveLedger(path,123)
            usage={'prompt_cache_hit_tokens':10,'prompt_cache_miss_tokens':20,
                   'prompt_tokens':30,'completion_tokens':5,'total_tokens':35}
            ledger.usage('one',usage,datetime.fromisoformat('2026-11-06T10:00:00+08:00').timestamp())
            ledger.usage('one',{},datetime.now().timestamp())
            self.assertEqual(LiveLedger(path,123).snapshot()['costYuan'],.0000804)
            self.assertEqual(ledger.snapshot()['unknownCost'],0)
