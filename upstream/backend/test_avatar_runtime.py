import json
import tempfile
import unittest
from pathlib import Path
from avatar_runtime import AvatarAssets, AvatarQueue

class AvatarTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.model=self.root/'model';self.model.mkdir()
        (self.root/'core.js').write_text('// user sdk')
        (self.model/'a.model3.json').write_text(json.dumps({'FileReferences':{'Moc':'a.moc3','Textures':['a.png']}}))
        for name in ['a.moc3','a.png','secret.txt']:(self.model/name).write_bytes(b'x')
        (self.model/'Exp3').mkdir();(self.model/'Exp3'/'happy.exp3.json').write_text('{"Parameters":[]}')
        self.assets=AvatarAssets(self.model,self.root/'core.js')
    def test_read_only_allowlist(self):
        self.assertIsNotNone(self.assets.asset('/model/a.png'))
        for path in ['/model/secret.txt','/model/../core.js','/model/%2e%2e/core.js','/vendor/unknown.js']:
            self.assertIsNone(self.assets.asset(path))
    def test_reference_escape_rejected(self):
        for name in ['../core.js','C:/core.js','a\\b','/core.js']:
            with self.assertRaises(ValueError):self.assets.allow(name)
    def test_dynamic_catalog(self):
        self.assertEqual(self.assets.catalog()['expressions'],['happy'])
        self.assertFalse(self.assets.catalog()['automaticEmotion'])
    def test_queue_validation_and_receipts(self):
        q=AvatarQueue(self.assets)
        for p in [{'expression':'invented'},{'seconds':float('nan')},{'seconds':True},{'seconds':100}]:
            with self.assertRaises(ValueError):q.submit(p)
        e=q.submit({'expression':'happy','seconds':1})
        self.assertEqual(q.poll(0)[0]['state'],'queued')
        q.ack(e['id'],'playing');q.ack(e['id'],'completed');q.ack(e['id'],'playing')
        self.assertEqual(q.status()[0]['state'],'completed')
    def test_assets_do_not_contain_model_or_core(self):
        from avatar_runtime import ROOT
        self.assertFalse(list(ROOT.rglob('*.moc3')))
        self.assertFalse(list(ROOT.rglob('*model3.json')))
        self.assertFalse(list(ROOT.rglob('live2dcubismcore*')))
    def test_http_auth_and_no_chat_required(self):
        import threading, urllib.request, urllib.error
        from http.server import ThreadingHTTPServer
        from test_live_pilot import viewer
        server=ThreadingHTTPServer(('127.0.0.1',0),lambda *a:None)
        port=server.server_port;origin=f'http://127.0.0.1:{port}'
        server.RequestHandlerClass=viewer.handler(self.root,self.root,port,avatar=AvatarQueue(self.assets))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            config=json.load(urllib.request.urlopen(origin+'/api/config'))
            self.assertEqual(config['avatarUrl'],'/avatar')
            headers={'Origin':origin,'X-Pilot-Token':config['token'],'Content-Type':'application/json'}
            for change in [{'Origin':'https://evil.test'},{'X-Pilot-Token':''},{'Host':'evil.test'}]:
                req=urllib.request.Request(origin+'/api/avatar/perform',data=b'{}',headers=headers|change)
                with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(req)
                self.assertEqual(e.exception.code,403)
            req=urllib.request.Request(origin+'/api/avatar/perform',data=b'{"expression":"happy"}',headers=headers)
            self.assertEqual(json.load(urllib.request.urlopen(req))['state'],'queued')
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
