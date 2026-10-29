// 보기 전용 클라우드 사본을 지금 데이터로 올린다: npm run publish
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishViewer } from './lib/publish.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '.env')); } catch { /* .env는 선택 */ }
const r = await publishViewer(here);
process.exit(r.error ? 1 : 0);
