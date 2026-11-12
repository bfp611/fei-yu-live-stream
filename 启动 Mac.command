#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
unset ELECTRON_RUN_AS_NODE
ARCH="$(uname -m)"
if [ "$ARCH" = arm64 ]; then NODE='./runtime/darwin-arm64/node'; else NODE='./runtime/darwin-x64/node'; fi
if [ ! -f "$NODE" ]; then echo '缺少运行环境，请完整解压整个包。'; exit 1; fi
chmod u+x "$NODE"
"$NODE" launch.mjs "$@" || { echo '启动未完成，请将以上信息交给您的AI助手；无需关闭系统安全保护。'; read -r -p '按回车退出…' _; exit 1; }
