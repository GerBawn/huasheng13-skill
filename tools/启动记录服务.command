#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
echo "正在启动公考记录服务…"
exec node "$DIR/gongkao-server.js"
