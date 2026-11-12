"""OS lifetime lock, shared by chat and game rooms; no stale-lock deletion."""
from pathlib import Path

class ServiceLock:
    def __init__(self, home, room):
        root=Path(home)/'runtime-locks';root.mkdir(parents=True,exist_ok=True)
        self.file=open(root/f'live-room-{int(room)}.lock','a+b')
        self.file.seek(0);self.file.write(b'0');self.file.flush();self.file.seek(0)
        try:
            import os
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.file,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise RuntimeError('同一直播间已有服务占用；请停止旧服务，不要同时启用聊天和游戏接收器')
