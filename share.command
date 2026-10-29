#!/bin/bash
# 더블클릭하면 외부에서 접속할 수 있는 주소(https://….trycloudflare.com)를 엽니다.
# UX KPI 대시보드 서버(start.command)가 켜져 있어야 하고, 이 창을 닫으면 공유가 끝납니다.
# 주소는 열 때마다 바뀝니다. 접속하려면 .env의 APP_PASSWORD가 필요합니다.
cd "$(dirname "$0")" || exit 1
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)
PORT=${PORT:-4321}
CF=$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)
if [ ! -x "$CF" ]; then
  echo "cloudflared가 없습니다. 터미널에서 brew install cloudflared 를 실행한 뒤 다시 여세요."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다."; exit 1
fi
if ! grep -qE '^APP_PASSWORD=.+' .env 2>/dev/null; then
  echo ".env에 APP_PASSWORD가 없습니다. 비밀번호 없이 외부에 열면 누구나 들어올 수 있어 공유를 멈춥니다."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다."; exit 1
fi
if ! curl -s -o /dev/null "http://localhost:$PORT/"; then
  echo "UX KPI 대시보드 서버가 꺼져 있습니다. start.command를 먼저 실행하세요."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다."; exit 1
fi
echo "공유 주소를 만드는 중입니다… 아래에 https://….trycloudflare.com 주소가 나오면 팀원에게 비밀번호와 함께 보내세요."
echo "끝내려면 이 창을 닫거나 Ctrl+C."
"$CF" tunnel --no-autoupdate --url "http://localhost:$PORT" 2>&1 | while IFS= read -r line; do
  url=$(printf '%s' "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com')
  if [ -n "$url" ]; then echo; echo "  공유 주소: $url"; echo; printf '%s' "$url" | pbcopy && echo "  (클립보드에 복사했습니다)"; fi
done
