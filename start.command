#!/bin/bash
# 더블클릭하면 UX KPI 대시보드 서버를 켜고 브라우저를 엽니다. 끄려면 이 창을 닫거나 Ctrl+C.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 없습니다. https://nodejs.org 에서 설치한 뒤 다시 실행하세요."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다."
  exit 1
fi
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)
PORT=${PORT:-4321}
# 이미 켜진 서버가 있으면 새로 켜지 않고 화면만 엽니다(서버 둘이 같은 파일에 쓰면 저장 내용을 덮어씁니다).
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "이미 켜져 있습니다. 브라우저만 엽니다: http://localhost:$PORT"
  open "http://localhost:$PORT"
  exit 0
fi
(sleep 1.5 && open "http://localhost:$PORT") &
node server.mjs
