"""Persistent, room-scoped live allowance ledger; never touches DSH memories."""
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from live_pricing import flash_cost


class LiveLedger:
    def __init__(self, path, room):
        self.path, self.room = str(path), str(room)
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, room TEXT, started REAL, initial INTEGER, rate REAL);
                CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, session TEXT, kind TEXT, amount INTEGER, payload TEXT, created REAL);
            ''')
            row = db.execute('SELECT id FROM sessions WHERE room=? ORDER BY started DESC LIMIT 1', (self.room,)).fetchone()
            self.session = row[0] if row else str(uuid.uuid4())
            if not row:
                db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (self.session, self.room, time.time(), 0, 0))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def settings(self, initial, rate):
        import math
        if type(initial) is not int or not 0 <= initial <= 10**12:
            raise ValueError('初始口粮须为非负整数')
        if type(rate) not in (int, float) or not math.isfinite(rate) or not 0 <= rate <= 10**9:
            raise ValueError('折算比例无效')
        with self.connect() as db:
            db.execute('UPDATE sessions SET initial=?,rate=? WHERE id=?', (initial, rate, self.session))

    def add(self, key, kind, amount, payload):
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?)',
                       (key, self.session, kind, amount, json.dumps(payload, ensure_ascii=False), time.time()))

    def usage(self, request_id, usage, timestamp=None, purpose="unclassified"):
        total = usage.get('total_tokens')
        if type(total) is not int or total < 0:
            self.add('usage:'+request_id, 'missing_usage', 0, {})
        else:
            payload = dict(usage)
            payload['purpose'] = purpose
            payload['billing'] = flash_cost(usage, time.time() if timestamp is None else timestamp)
            self.add('usage:'+request_id, 'usage', total, payload)

    def gift(self, gift):
        # SEND_GIFT is a transaction; never also count COMBO_SEND summaries.
        # No stable transaction ID means it is not safe to credit automatically.
        transaction = gift.tid or gift.rnd
        amount = gift.total_coin
        if not transaction or type(amount) is not int or amount < 0:
            return
        self.add('gift:'+self.room+':'+str(transaction),
                 'gold' if gift.coin_type == 'gold' else 'free',
                 amount if gift.coin_type == 'gold' else 0,
                 {'gift': gift.gift_name, 'quantity': gift.num, 'coin_type': gift.coin_type})

    def snapshot(self):
        with self.connect() as db:
            initial, rate, started = db.execute('SELECT initial,rate,started FROM sessions WHERE id=?', (self.session,)).fetchone()
            sums = dict(db.execute('SELECT kind,SUM(amount) FROM events WHERE session=? GROUP BY kind', (self.session,)))
            missing = db.execute("SELECT COUNT(*) FROM events WHERE session=? AND kind='missing_usage'", (self.session,)).fetchone()[0]
            count = db.execute("SELECT COUNT(*) FROM events WHERE session=? AND kind IN ('gold','free')", (self.session,)).fetchone()[0]
            usage_rows = db.execute("SELECT payload FROM events WHERE session=? AND kind='usage'", (self.session,)).fetchall()
        categories = {}
        for row in usage_rows:
            entry = json.loads(row[0])
            category = categories.setdefault(entry.get('purpose', 'unclassified'), {'calls':0, 'tokens':0})
            category['calls'] += 1
            category['tokens'] += entry.get('total_tokens', 0)
        gold = sums.get('gold', 0)
        earned = int(gold * rate / 1000)
        consumed = sums.get('usage', 0)
        billings = [json.loads(row[0]).get('billing') for row in usage_rows]
        cost = sum(b['nanoYuan'] for b in billings if b)/10**9
        unknown_cost = missing + sum(b is None for b in billings)
        return dict(session=self.session, started=started, initial=initial, tokensPerYuan=rate,
                    usageCategories=categories, consumed=consumed, giftYuan=gold/1000, earned=earned,
                    balance=initial+earned-consumed, missingUsage=missing, giftTransactions=count,
                    costYuan=cost, netYuan=gold/1000-cost, unknownCost=unknown_cost,
                    priceSource='https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
