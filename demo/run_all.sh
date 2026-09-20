#!/usr/bin/env bash
# 一口气跑完三场。加 NO_COLOR=1 可以去掉颜色（存档用）。
set -e
cd "$(dirname "$0")"
PY=${PYTHON:-python3}
for s in client_stdio.py client_http.py mcp_client.py; do
  echo
  echo "################################################################"
  echo "#  $s"
  echo "################################################################"
  "$PY" "$s" 2>/dev/null
done
