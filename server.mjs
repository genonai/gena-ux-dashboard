// UX KPI 대시보드 로컬 서버. `npm start` 또는 start.command를 실행한 뒤 http://localhost:4321 을 연다.
import http from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore, COLLECTIONS, ID_RE, NotFound } from './lib/store.mjs';
import { loadLogic } from './lib/logic.mjs';
import { aiReady, runClaude } from './lib/ai.mjs';
import { amplitudeReady, fetchReady, fetchChartCsv } from './lib/amplitude.mjs';
import { runSource, runAll, runMany, refreshJob, startScheduler, nextScheduledSlot, runBackfill, backfillJob, scheduleText } from './lib/refresh.mjs';
import { analyzeAll, analyzeJob, pendingAnalyses } from './lib/analyze.mjs';
import { publishViewer, publishJob } from './lib/publish.mjs';
import { buildUxReport, uxReportJob } from './lib/uxreport.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '.env')); } catch { /* .env는 선택 */ }

const PORT = Number(process.env.PORT) || 4321;
// 기본은 이 Mac에서만 접속. 사내망 공유는 HOST=0.0.0.0 (로그인이 없으니 주의)
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(here, 'public');
const store = createStore(path.join(here, 'data'));
const L = loadLogic(path.join(PUBLIC, 'index.html'));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const MAX_BODY = 12 * 1024 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// 외부 공유(터널 등)용 비밀번호. .env에 APP_PASSWORD가 있으면 로그인 화면(비밀번호 하나)을 거쳐야 들어온다.
// 맞게 넣으면 30일짜리 쿠키를 준다. 쿠키 값은 비밀번호에서 만든 값이라, 비밀번호를 바꾸면 기존 로그인은 모두 풀린다.
const PASSWORD = process.env.APP_PASSWORD || '';
const COOKIE = 'amp_auth';
const SESSION_DAYS = 30;
const sessionToken = PASSWORD ? createHmac('sha256', PASSWORD).update('amp-auth-v1').digest('base64url') : '';
const sameSecret = (x, y) => timingSafeEqual(createHash('sha256').update(String(x)).digest(), createHash('sha256').update(String(y)).digest());
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function authorized(req) {
  if (!PASSWORD) return true;
  const c = cookieOf(req, COOKIE);
  if (c && sameSecret(c, sessionToken)) return true;
  // 스크립트용(curl -u): HTTP Basic 비밀번호도 받는다. 사용자 이름은 무시한다.
  const m = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  return !!m && sameSecret(Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':'), PASSWORD);
}
// 로그인 시도 제한: 접속지(IP)마다 10분에 10번
const attempts = new Map();
function tooMany(req) {
  const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
  const now = Date.now(), list = (attempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now); attempts.set(ip, list);
  return list.length > 10;
}
async function handleLogin(req, res) {
  if (tooMany(req)) return send(res, 429, { code: 'rate_limited' });
  const body = await readJson(req).catch(() => null);
  if (!body || typeof body.password !== 'string' || !sameSecret(body.password, PASSWORD)) return send(res, 401, { code: 'wrong_password' });
  attempts.delete(String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '')); // 맞게 들어오면 시도 횟수를 비운다
  const secure = req.headers['x-forwarded-proto'] === 'https' || /\.trycloudflare\.com$/i.test(String(req.headers.host || '').replace(/:\d+$/, ''));
  res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  return send(res, 200, { ok: true });
}

// 다른 웹사이트가 이 서버로 요청을 보내지 못하게 막는다 (Host 확인 + 쓰기 요청엔 사용자 정의 헤더 필수).
// 비밀번호를 걸었으면 터널 주소 같은 다른 Host로도 들어올 수 있다.
function allowed(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (HOST === '127.0.0.1' && !PASSWORD && !['localhost', '127.0.0.1', '::1'].includes(host)) return false;
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'amp') return false;
  return true;
}

const sseClients = new Set();
store.onChange(c => { for (const res of sseClients) res.write(`event: change\ndata: ${JSON.stringify({ c })}\n\n`); });

let runAllBusy = false;
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // 'api' 다음

  if (parts[0] === 'status' && req.method === 'GET') {
    const st = (await store.get('settings', 'refresh')) || {};
    return send(res, 200, { ai: await aiReady(), amplitude: await fetchReady(), nextAutoRefresh: nextScheduledSlot().getTime(), schedule: scheduleText(), lastAutoRun: st.lastAutoRun || null });
  }

  if (parts[0] === 'events' && req.method === 'GET') {
    // no-transform·X-Accel-Buffering: 터널이나 프록시(Cloudflare 등)가 압축하려고 붙잡아 두지 않고 바로 흘려보내게 한다.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    // hello가 도착하면 페이지는 실시간 알림이 된다고 보고, 안 오면(일부 터널은 스트림을 못 넘긴다) 주기적으로 다시 읽는다.
    res.write('event: hello\ndata: {}\n\n');
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  if (parts[0] === 'db') {
    const [, c, id] = parts;
    if (!COLLECTIONS.has(c) || (id !== undefined && !ID_RE.test(id)) || parts.length > 3) return send(res, 404, { code: 'not_found' });
    if (!id) {
      if (req.method !== 'GET') return send(res, 405, { code: 'method' });
      return send(res, 200, await store.list(c));
    }
    if (req.method === 'GET') {
      const d = await store.get(c, id);
      return send(res, 200, d ? { id, exists: true, data: d } : { id, exists: false });
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { code: 'invalid_argument' });
      try { req.method === 'PUT' ? await store.set(c, id, body) : await store.update(c, id, body); }
      catch (e) { if (e instanceof NotFound) return send(res, 404, { code: 'not_found' }); throw e; }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') { await store.remove(c, id); return send(res, 200, { ok: true }); }
    return send(res, 405, { code: 'method' });
  }

  if (parts[0] === 'ai' && req.method === 'POST') {
    if (!(await aiReady())) return send(res, 503, { code: 'not_granted' });
    const body = await readJson(req);
    const prompt = body && typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt) return send(res, 400, { code: 'invalid_argument' });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const ctl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
    let last = 0;
    try {
      const out = await runClaude(prompt, {
        signal: ctl.signal,
        onText: t => { const d = t.slice(last); last = t.length; if (d) res.write(JSON.stringify({ d }) + '\n'); },
      });
      res.end(JSON.stringify({ done: true, text: out.text, truncated: out.truncated }) + '\n');
    } catch (e) {
      if (!res.writableEnded) res.end(JSON.stringify({ error: e.code || 'error', message: e.message, text: e.text || '' }) + '\n');
    }
    return;
  }

  // AI 해석 일괄 실행: 지표마다 최신 저장본 중 해석이 없는 것을 백그라운드로 해석한다.
  if (parts[0] === 'analyze-all') {
    if (req.method === 'GET') return send(res, 200, { ...analyzeJob(), pending: (await pendingAnalyses(store)).length });
    if (req.method === 'POST') {
      if (!(await aiReady())) return send(res, 503, { code: 'not_granted', message: 'Claude Code를 찾지 못했습니다.' });
      if (!analyzeJob().running) analyzeAll(store, L).catch(e => console.error('[AI 해석]', e));
      return send(res, 202, analyzeJob());
    }
  }

  // 데이터 해석 탭: Amplitude 차트 링크로 데이터 불러오기. 저장하지 않고 CSV와 차트 종류만 돌려준다.
  if (parts[0] === 'fetch-chart' && req.method === 'POST') {
    if (!(await fetchReady())) return send(res, 503, { code: 'amplitude_not_configured', message: 'Amplitude에서 데이터를 가져올 수 없습니다. Claude Code의 Amplitude 커넥터 로그인을 확인하세요.' });
    const body = await readJson(req).catch(() => null) || {};
    const chart = typeof body.chart === 'string' ? body.chart.trim() : '';
    if (!/^https:\/\/[a-z0-9.-]*amplitude\.com\/\S+$/i.test(chart)) return send(res, 400, { code: 'invalid_argument', message: 'Amplitude 차트 주소(https://app.amplitude.com/…/chart/…)를 넣으세요.' });
    const days = Number.isInteger(body.days) && body.days > 0 && body.days <= 366 ? body.days : undefined;
    const r = body.range && /^\d{4}-\d{2}-\d{2}$/.test(body.range.start || '') && /^\d{4}-\d{2}-\d{2}$/.test(body.range.end || '') && body.range.start <= body.range.end ? body.range : undefined;
    try {
      const { csv, definition } = await fetchChartCsv(chart, { signal: AbortSignal.timeout(240000), days, range: r });
      const TYPE_OF = { funnels: 'funnel', eventsSegmentation: 'segmentation', retention: 'retention', customerJourney: 'journeys', journeys: 'journeys' };
      const p = definition && definition.params;
      return send(res, 200, { csv, type: definition ? TYPE_OF[definition.type] || null : null, name: (definition && definition.name) || '', range: r || null, chartRange: p && p.range || null });
    } catch (e) {
      return send(res, 502, { code: e.code || 'error', message: String(e && e.message || e).slice(0, 300) });
    }
  }

  // 종합 UX 진단 리포트 (백그라운드). GET은 진행 상황과 마지막 리포트.
  if (parts[0] === 'ux-report') {
    if (req.method === 'GET') return send(res, 200, { ...uxReportJob(), saved: await store.get('settings', 'uxReport') });
    if (req.method === 'POST') {
      if (!(await aiReady())) return send(res, 503, { code: 'not_granted', message: 'Claude Code를 찾지 못했습니다.' });
      if (!uxReportJob().running) buildUxReport(store, L).catch(e => console.error('[종합 진단]', e));
      return send(res, 202, uxReportJob());
    }
  }

  // 보기 전용 클라우드 사본 올리기 (백그라운드). GET은 진행 상황.
  if (parts[0] === 'publish') {
    if (req.method === 'GET') return send(res, 200, publishJob());
    if (req.method === 'POST') { if (!publishJob().running) publishViewer(here).catch(e => console.error('[클라우드 사본]', e)); return send(res, 202, publishJob()); }
  }

  // 이전 기간 채우기 (백그라운드). GET은 진행 상황.
  if (parts[0] === 'backfill') {
    if (req.method === 'GET') return send(res, 200, backfillJob());
    if (req.method === 'POST') {
      if (!(await fetchReady())) return send(res, 503, { code: 'amplitude_not_configured' });
      if (!backfillJob().running) runBackfill(store, L).catch(e => console.error('[이전 기간]', e));
      return send(res, 202, backfillJob());
    }
  }

  // 갱신 진행 상황(몇 개째인지)
  if (parts[0] === 'refresh-status' && req.method === 'GET') return send(res, 200, refreshJob());

  if (parts[0] === 'sources' && req.method === 'POST') {
    if (!(await fetchReady())) return send(res, 503, { code: 'amplitude_not_configured', message: '.env에 Amplitude API 키를 넣거나 Claude Code를 설치하세요.' });
    if (parts[1] === 'run-all') {
      // 57개를 차례로 받는 데 20분 가까이 걸린다. 이미 도는 중이면 겹쳐 돌리지 않는다(같은 차트를 동시에 받으면 저장본이 중복된다).
      if (runAllBusy) return send(res, 409, { code: 'already_running', message: '이미 모든 차트를 갱신하는 중입니다.' });
      runAllBusy = true;
      try { return send(res, 200, { results: await runAll(store, L) }); } finally { runAllBusy = false; }
    }
    if (parts[1] === 'run-many') {
      const b = await readJson(req).catch(() => null) || {};
      const ids = Array.isArray(b.ids) ? b.ids.filter(x => typeof x === 'string' && ID_RE.test(x)).slice(0, 200) : [];
      if (!ids.length) return send(res, 400, { code: 'invalid_argument', message: 'ids가 필요합니다.' });
      if (refreshJob().running) return send(res, 409, { code: 'already_running', message: '이미 갱신하는 중입니다.' });
      runMany(store, L, ids).catch(e => console.error('[갱신]', e));
      return send(res, 202, refreshJob());
    }
    if (parts[2] === 'run' && ID_RE.test(parts[1] || '')) return send(res, 200, await runSource(store, L, parts[1]));
  }

  return send(res, 404, { code: 'not_found' });
}

async function serveStatic(res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  try { send(res, 200, await fs.readFile(file), TYPES[path.extname(file)] || 'application/octet-stream'); }
  catch { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!authorized(req)) {
      // 로그인 전: 로그인 요청만 받고, 화면 요청엔 로그인 화면을, API엔 401을 돌려준다.
      if (url.pathname === '/api/login' && req.method === 'POST' && allowed(req)) return await handleLogin(req, res);
      if (url.pathname.startsWith('/api/')) return send(res, 401, { code: 'login_required' });
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      return send(res, 200, await fs.readFile(path.join(PUBLIC, 'login.html')), 'text/html; charset=utf-8');
    }
    if (!allowed(req)) return send(res, 403, { code: 'forbidden' });
    if (url.pathname === '/login.html') { res.writeHead(302, { Location: '/' }); return res.end(); }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { code: 'method' });
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    return await serveStatic(res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { code: e.status === 413 ? 'quota_exceeded' : 'error' });
    else res.end();
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT}을(를) 이미 쓰고 있습니다. 이미 켜진 서버가 있으면 그 창을 쓰세요: http://localhost:${PORT}`);
    console.error('(서버를 두 개 켜면 서로의 저장 내용을 덮어쓸 수 있어 켜지 않습니다.)');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, async () => {
  const where = HOST === '127.0.0.1' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`UX KPI 대시보드: ${where}`);
  console.log(`  AI 해석: ${(await aiReady()) ? 'Claude Code 사용' : '꺼짐 (Claude Code를 찾지 못함)'}`);
  const how = amplitudeReady() ? 'API 키 + Claude Code 커넥터' : 'Claude Code의 Amplitude 커넥터';
  console.log(`  Amplitude 자동 갱신: ${(await fetchReady()) ? `켜짐 (${scheduleText()}, ${how})` : '꺼짐 (.env에 API 키를 넣거나 Claude Code 설치 필요)'}`);
  console.log(`  비밀번호: ${PASSWORD ? '켜짐 (.env의 APP_PASSWORD)' : '꺼짐'}`);
  console.log('  끄려면 이 창에서 Ctrl+C');
  // 자동 갱신이 끝나면 새 저장본의 AI 해석까지 이어서 돌린다 (AUTO_ANALYZE=off로 끔).
  // 자동 갱신 뒤: 바로 앞 같은 길이 기간 저장본이 없으면 채우고(직전 대비용, 이미 있으면 건너뜀), 새 저장본의 AI 해석을 돌리고,
  // 트래커 자동 등록 → 클라우드 사본 올리기까지 이어서 한다.
  const ai = process.env.AUTO_ANALYZE !== 'off' && (await aiReady());
  // 각 작업은 끝나면 기록해 두고, 서버가 중간에 꺼졌다 켜지면 끝나지 않은 작업부터 이어서 한다.
  const after = async steps => {
    const step = async (name, fn) => { if (await steps.done(name)) return; await fn(); await steps.mark(name); };
    // 새로 등록한 지표의 지난 기간 채우기는 사용량이 커서 기본으로 끈다(BACKFILL=on으로 켬). 지난 기간은 매주 갱신이 쌓아 간다.
    if (process.env.BACKFILL === 'on') await step('backfill', () => runBackfill(store, L).catch(e => console.error('[이전 기간]', e)));
    if (ai) await step('analyze', () => analyzeAll(store, L));
    // 종합 진단은 지표 전체를 읽어 사용량이 가장 크다. 기본으로 끄고 화면의 버튼으로 필요할 때만 만든다(UXREPORT=on으로 매주 자동).
    if (ai && process.env.UXREPORT === 'on') await step('uxreport', () => buildUxReport(store, L));
    // 보기 전용 클라우드 사본은 사용자가 올리라고 할 때만 올린다. 매주 자동 갱신 뒤에도 올리려면 PUBLISH=on
    if (process.env.PUBLISH === 'on') await step('publish', () => publishViewer(here));
  };
  if (process.env.AUTO_REFRESH !== 'off') startScheduler(store, L, console.log, after);
});
