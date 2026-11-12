"""Single-viewer, loopback-only WebRTC signaling; no media or game commands."""
import secrets
import threading
import time


class GameVideo:
    def __init__(self):
        self.lock = threading.Lock()
        self.token = secrets.token_urlsafe(32)
        self.state = None
        self.touched = 0

    def read(self):
        with self.lock:
            if time.monotonic() - self.touched > 15:
                self.state = None
            return dict(self.state) if self.state else None

    def write(self, body):
        with self.lock:
            kind = body.get('kind')
            identity = body.get('id')
            if not isinstance(identity, str) or not 1 <= len(identity) <= 80:
                raise ValueError('Invalid video session')
            if kind == 'offer':
                sdp = body.get('sdp')
                if not isinstance(sdp, str) or not sdp.startswith('v=0') or len(sdp) > 64000:
                    raise ValueError('Invalid SDP')
                if self.state and self.state['id'] != identity and time.monotonic()-self.touched < 15:
                    raise ValueError('Another preview owns the video stream')
                self.state = {'id': identity, 'offer': sdp, 'answer': None}
                self.touched = time.monotonic()
            elif not self.state or self.state['id'] != identity:
                raise ValueError('Stale video session')
            elif kind == 'answer':
                sdp = body.get('sdp')
                if not isinstance(sdp, str) or not sdp.startswith('v=0') or len(sdp) > 64000:
                    raise ValueError('Invalid SDP')
                self.state['answer'] = sdp
            elif kind == 'stats':
                values = body.get('values')
                import math
                if not isinstance(values, dict) or len(values) > 12 or any(
                    k not in ('sourceFPS','fps','frames','width','height','encodeMs','renderMs','ticks','timestamp') or
                    type(v) not in (int,float) or not math.isfinite(v) or v < 0 for k,v in values.items()):
                    raise ValueError('Invalid video statistics')
                self.state['sourceStats'] = values
            elif kind == 'heartbeat':
                values=body.get('values')
                if isinstance(values,dict) and len(values)<=8:
                    import math
                    if all(k in ('fps','frames','dropped','width','height','timestamp') and type(v) in (int,float) and math.isfinite(v) and v>=0 for k,v in values.items()):
                        self.state['viewerStats']=values
                self.touched = time.monotonic()
            elif kind == 'close':
                self.state = None
            else:
                raise ValueError('Invalid video operation')
