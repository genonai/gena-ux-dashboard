// 서버 없이 켜진 자동 갱신 차트를 한 번에 가져온다: npm run refresh
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.mjs';
import { loadLogic } from './lib/logic.mjs';
import { runAll } from './lib/refresh.mjs';
import { fetchReady } from './lib/amplitude.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '.env')); } catch { /* .env는 선택 */ }
// 서버가 켜져 있으면 이 스크립트가 파일을 따로 쓰다 서버의 저장본과 어긋난다. 화면의 '모두 갱신'을 쓰게 한다. (그래도 하려면 --force)
const port = process.env.PORT || 4321;
if (!process.argv.includes('--force') && await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false)) {
  console.error(`서버(http://localhost:${port})가 켜져 있습니다. 화면의 '모두 갱신'을 쓰거나, 서버를 끈 뒤 다시 실행하세요. (무시하려면 npm run refresh -- --force)`);
  process.exit(1);
}
if (!(await fetchReady())) { console.error('.env에 AMPLITUDE_API_KEY와 AMPLITUDE_SECRET_KEY를 넣거나 Claude Code를 설치해 주세요.'); process.exit(1); }

const results = await runAll(createStore(path.join(here, 'data')), loadLogic(path.join(here, 'public', 'index.html')));
if (!results.length) console.log('켜진 자동 갱신 차트가 없습니다. UX KPI 대시보드 화면에서 차트를 추가하세요.');
for (const r of results) console.log(`${r.ok ? '완료' : '실패'}  ${r.title}${r.ok ? '' : `: ${r.error}`}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
