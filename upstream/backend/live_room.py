"""Read-only Bilibili WebSocket receiver. No comment or stream publishing API."""
import asyncio
from collections import deque
import hashlib
import http.cookies
import json
import logging
import threading
import time
import uuid
from live_coalesce import identity, merge_comments, take_same_viewer

class LiveRoom:
    def __init__(self, room, credential, ledger=None, event_sink=None):
        self.event_sink = event_sink
        self.ledger = ledger
        self.room, self.credential = room, credential
        self.lock = threading.Lock()
        self.queue = deque(maxlen=12)
        self.seen = deque(maxlen=200)
        self.session = str(uuid.uuid4())
        self.last_heartbeat = 0
        self.status = '连接中'
        self.consumer = None
        self.consumer_until = 0

    def start(self):
        threading.Thread(target=self._run, daemon=True, name='bili-live-receiver').start()

    def snapshot(self):
        with self.lock:
            return {'room':self.room,'status':self.status if time.time()-self.last_heartbeat<65 else '等待连接或心跳', 'queued':len(self.queue)}

    def receive(self, name, text, timestamp, uid=None):
        if not text or len(text)>500: return
        uid = identity(uid)
        digest=hashlib.sha256(f'{uid or name}:{timestamp}:{text}'.encode()).hexdigest()
        with self.lock:
            if digest in self.seen: return
            self.seen.append(digest)
        if self.event_sink and self.event_sink(str(name)[:40], text, digest, uid=uid): return
        with self.lock:
            self.queue.append({'id':digest,'uid':uid,'name':str(name)[:40], 'text':text, 'received':time.time()})

    def next(self, consumer):
        uuid.UUID(consumer)
        with self.lock:
            now=time.time()
            if self.consumer != consumer and self.consumer_until>now: return None
            self.consumer, self.consumer_until=consumer, now+180
            while self.queue:
                item=self.queue.popleft()
                if now-item['received']<=60:
                    items = take_same_viewer(self.queue,item,lambda i:i.get('uid') if now-i['received']<=60 else None)
                    return merge_comments(items)
        return None

    def _run(self):
        # Upstream logs can include packet bodies; keep them out of local service logs.
        logging.getLogger('blivedm').disabled=True
        for name in ('blivedm.clients.web','blivedm.clients.ws_base','blivedm.clients.base'):
            logging.getLogger(name).disabled=True
        try: asyncio.run(self._listen())
        except Exception:
            with self.lock: self.status='连接失败，请重启接收器'

    async def _listen(self):
        import aiohttp
        import blivedm
        owner=self
        class Handler(blivedm.BaseHandler):
            def _on_gift(self, client, message):
                if owner.ledger:
                    owner.ledger.gift(message)
            def _on_heartbeat(self, client, message):
                with owner.lock:
                    owner.last_heartbeat=time.time();owner.status='已连接真实弹幕'
            def _on_danmaku(self, client, message):
                owner.receive(message.uname,message.msg,message.timestamp,uid=getattr(message,'uid',None))
        cred=json.loads(self.credential.read_text(encoding='utf-8-sig')) if self.credential else {}
        cookies=http.cookies.SimpleCookie()
        for src,dst in [('sessdata','SESSDATA'),('buvid3','buvid3'),('dedeuserid','DedeUserID')]:
            if cred.get(src):
                cookies[dst]=str(cred[src]);cookies[dst]['domain']='bilibili.com'
        async with aiohttp.ClientSession(trust_env=True) as session:
            session.cookie_jar.update_cookies(cookies)
            client=blivedm.BLiveClient(self.room,session=session)
            client.set_handler(Handler());client.start()
            try: await client.join()
            finally: await client.stop_and_close()
