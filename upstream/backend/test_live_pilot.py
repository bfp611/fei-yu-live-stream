import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer
from live_pilot_chat import LiveChat, Busy

spec=importlib.util.spec_from_file_location('viewer',Path(__file__).with_name('live-pilot-server.py'))
viewer=importlib.util.module_from_spec(spec);spec.loader.exec_module(viewer)

class FakeChat:
    audio={}
    calls=0
    def reply(self,session,text):
        self.calls+=1
        return {'text':'测试回复','audio':None}

class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.chat=FakeChat()
        self.server=ThreadingHTTPServer(('127.0.0.1',0),lambda *a:None)
        port=self.server.server_port
        self.server.RequestHandlerClass=viewer.handler(self.root,self.root,port,chat=self.chat)
        self.origin=f'http://127.0.0.1:{port}'
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.token=json.load(urllib.request.urlopen(self.origin+'/api/config'))['token']
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def request(self,path='/api/chat',headers=None,data=b'{"session":"x","text":"hello"}'):
        req=urllib.request.Request(self.origin+path,data=data,headers=headers or {})
        try:
            with urllib.request.urlopen(req) as r:return r.status,r.read()
        except urllib.error.HTTPError as e:return e.code,e.read()
    def headers(self):return {'Origin':self.origin,'X-Pilot-Token':self.token,'Content-Type':'application/json'}
    def test_local_request(self):
        self.assertEqual(self.request(headers=self.headers())[0],200);self.assertEqual(self.chat.calls,1)
    def test_video_signal_origin_role_and_token_boundaries(self):
        port=self.server.server_port
        self.server.RequestHandlerClass=viewer.handler(self.root,self.root,port,chat=self.chat,game=object())
        token=json.load(urllib.request.urlopen(self.origin+'/api/game/video'))['token']
        headers={'Origin':self.origin,'Content-Type':'application/json','X-Video-Token':token}
        offer=json.dumps({'kind':'offer','id':'preview','sdp':'v=0\noffer'}).encode()
        self.assertEqual(self.request('/api/game/video',headers|{'Origin':'https://evil.test'},offer)[0],403)
        self.assertEqual(self.request('/api/game/video',headers|{'X-Video-Token':''},offer)[0],403)
        source=headers|{'Origin':'http://127.0.0.1:15184'}
        self.assertEqual(self.request('/api/game/video',source,offer)[0],409)
        self.assertEqual(self.request('/api/game/video',headers,offer)[0],200)
        answer=json.dumps({'kind':'answer','id':'preview','sdp':'v=0\nanswer'}).encode()
        self.assertEqual(self.request('/api/game/video',headers,answer)[0],409)
        self.assertEqual(self.request('/api/game/video',source,answer)[0],200)
        self.assertEqual(self.request('/api/game/control',source,b'{"enabled":true}')[0],403)
    def test_forged_origin_and_missing_token(self):
        for change in [{'Origin':'https://evil.test'},{'X-Pilot-Token':''},{'Host':'evil.test'}]:
            self.assertEqual(self.request(headers=self.headers()|change)[0],403)
        self.assertEqual(self.chat.calls,0)
    def test_size_and_json(self):
        for data in [b'x'*8193,b'not json',b'[]']:
            self.assertEqual(self.request(headers=self.headers(),data=data)[0],400)
        self.assertEqual(self.chat.calls,0)
    def test_paths(self):
        (self.root/'secret.txt').write_text('private')
        self.assertEqual(self.request('/pet/../secret.txt',data=None)[0],404)
        self.assertEqual(self.request('/take/../secret.txt',data=None)[0],404)
    def test_chat_validation_and_single_flight(self):
        import uuid
        chat=LiveChat(self.root,self.root);sid=str(uuid.uuid4())
        for value in ['', 'x'*501,None]:
            with self.assertRaises(ValueError):chat.reply(sid,value)
        chat.lock.acquire()
        try:
            with self.assertRaises(Busy):chat.reply(sid,'hello')
        finally:chat.lock.release()

class LiveBoundaries(Boundaries):
    def setUp(self):
        super().setUp()
        from live_room import LiveRoom
        self.live=LiveRoom(1,self.root/'unused')
        self.chat.lock=threading.Lock()
        async def reply(session,text,live=False):
            self.chat.calls+=1
            return {'text':text,'audio':None}
        self.chat._reply=reply
        self.server.RequestHandlerClass=viewer.handler(self.root,self.root,self.server.server_port,chat=self.chat,live=self.live)
        self.token=json.load(urllib.request.urlopen(self.origin+'/api/config'))['token']
    def test_busy_keeps_comment(self):
        import uuid
        self.live.receive('viewer','hello',1)
        self.chat.lock.acquire()
        try:
            code,_=self.request('/api/live/next',headers=self.headers(),data=json.dumps({'session':str(uuid.uuid4())}).encode())
            self.assertEqual(code,409);self.assertEqual(len(self.live.queue),1)
        finally:self.chat.lock.release()
    def test_long_comment_once(self):
        import uuid
        self.live.receive('viewer','鱼'*500,1)
        self.live.receive('viewer','鱼'*500,1)
        body=json.dumps({'session':str(uuid.uuid4())}).encode()
        code,data=self.request('/api/live/next',headers=self.headers(),data=body)
        self.assertEqual(code,200);self.assertEqual(len(json.loads(data)['comment']['text']),500)
        self.request('/api/live/next',headers=self.headers(),data=body)
        self.assertEqual(self.chat.calls,1)
    def test_other_consumer_cannot_take(self):
        import uuid
        self.live.next(str(uuid.uuid4()))
        self.live.receive('viewer','hello',1)
        self.assertIsNone(self.live.next(str(uuid.uuid4())))
        self.assertEqual(len(self.live.queue),1)

if __name__=='__main__':unittest.main()
