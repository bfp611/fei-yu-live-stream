import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from live_ledger import LiveLedger


class LedgerTests(unittest.TestCase):
    def test_durable_room_scoped_dedup_and_free_gifts(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'ledger.db'
            ledger=LiveLedger(path,123)
            ledger.settings(500,200)
            gift=SimpleNamespace(tid='transaction',rnd='',total_coin=2500,coin_type='gold',gift_name='gift',num=2)
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda _:ledger.gift(gift),range(12)))
            gift.tid='free';gift.coin_type='silver';ledger.gift(gift)
            ledger.usage('request',{'total_tokens':150,'prompt_tokens':100,'completion_tokens':50})
            ledger.usage('request',{'total_tokens':150})
            restored=LiveLedger(path,123)
            result=restored.snapshot()
            self.assertEqual((result['consumed'],result['earned'],result['balance']),(150,500,850))
            self.assertEqual(result['giftTransactions'],2)
            self.assertEqual(LiveLedger(path,456).snapshot()['consumed'],0)

    def test_invalid_settings_missing_usage_and_unidentified_gift(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=LiveLedger(Path(root)/'ledger.db',123)
            for initial,rate in [(-1,1),(True,1),(0,float('nan')),(0,float('inf')),(0,-1)]:
                with self.assertRaises(ValueError):ledger.settings(initial,rate)
            ledger.usage('unknown',{})
            self.assertEqual(ledger.snapshot()['missingUsage'],1)
            ledger.gift(SimpleNamespace(tid='',rnd='',total_coin=1000))
            self.assertEqual(ledger.snapshot()['giftTransactions'],0)


if __name__=='__main__':unittest.main()
