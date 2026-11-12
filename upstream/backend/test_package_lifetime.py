import json
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from service_lock import ServiceLock

class PackageLifetimeTests(unittest.TestCase):
    def test_host_pipe_closure_exits_service(self):
        with tempfile.TemporaryDirectory() as root:
            persona=Path(root)/'SOUL.md';persona.write_text('A test character.')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            child=subprocess.Popen([sys.executable,'-u',str(Path(__file__).with_name('live-pilot-server.py')),
                '--managed','--home',root,'--persona',str(persona),'--port',str(port),
                '--jingyu-url','http://127.0.0.1:61948/'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                self.assertIn(b'Local rehearsal:',child.stdout.readline())
                from urllib.request import urlopen
                with urlopen(f'http://127.0.0.1:{port}/api/service',timeout=3) as response:
                    self.assertEqual(json.load(response)['name'],'dsh-live-studio')
                child.stdin.close();self.assertEqual(child.wait(timeout=5),0)
            finally:
                if child.poll() is None:child.kill();child.wait()
                child.stdout.close();child.stderr.close()

    def test_room_lock_rejects_duplicate_and_releases_on_exit(self):
        with tempfile.TemporaryDirectory() as root:
            first=ServiceLock(root,123)
            try:
                with self.assertRaises((RuntimeError,OSError)):ServiceLock(root,123)
            finally:first.file.close()
            second=ServiceLock(root,123);second.file.close()
