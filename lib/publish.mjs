// 보기 전용 클라우드 사본 올리기 (Cloudflare Pages).
// 화면(index.html·login.html) + 보기 전용 runtime + 지금 데이터 스냅샷(data/*.json) + 비밀번호 확인(Pages Functions)을
// .viewer 폴더에 만들고 wrangler로 올린다. 노트북이 꺼져 있어도 고정 주소로 볼 수 있다.
// 필요한 것: Cloudflare 계정 + 이 Mac에서 한 번 `npx wrangler login`, .env의 APP_PASSWORD.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const pagesProject = () => (process.env.PAGES_PROJECT || 'ux-kpi-dashboard').toLowerCase().replace(/[^a-z0-9-]/g, '-');

function run(cmd, args, { cwd, timeout = 10 * 60 * 1000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, out: String(e.message) }); });
    child.on('close', code => { clearTimeout(t); resolve({ code, out }); });
  });
}
const wrangler = (args, opts) => run('npx', ['--yes', 'wrangler@3', ...args], opts);

// 비밀번호 확인용 Pages Functions. 비밀번호 자체는 넣지 않고 해시만 넣는다.
// 쿠키 값은 비밀번호에서 만든 값이라, 비밀번호를 바꿔 다시 올리면 기존 로그인은 모두 풀린다.
function middleware(password) {
  const salt = randomBytes(12).toString('hex');
  const hash = createHash('sha256').update(salt + password).digest('hex');
  const token = createHmac('sha256', password).update('amp-viewer-v1').digest('hex');
  return `// 자동 생성: 보기 전용 사본의 비밀번호 확인
const SALT = ${JSON.stringify(salt)}, HASH = ${JSON.stringify(hash)}, TOKEN = ${JSON.stringify(token)};
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const authed = (ctx.request.headers.get('Cookie') || '').split(';').some(p => p.trim() === 'amp_auth=' + TOKEN);
  if (url.pathname === '/api/login' && ctx.request.method === 'POST') {
    const body = await ctx.request.json().catch(() => ({}));
    const h = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SALT + String(body.password || ''))));
    if (h !== HASH) return json({ code: 'wrong_password' }, 401);
    return json({ ok: true }, 200, { 'Set-Cookie': 'amp_auth=' + TOKEN + '; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax' });
  }
  if (authed) {
    if (url.pathname === '/login' || url.pathname === '/login.html') return Response.redirect(new URL('/', url).toString(), 302);
    const res = await ctx.next();
    const r = new Response(res.body, res); r.headers.set('cache-control', 'no-store'); r.headers.set('x-robots-tag', 'noindex'); return r;
  }
  if (url.pathname.startsWith('/data/') || url.pathname.startsWith('/api/')) return json({ code: 'login_required' }, 401);
  const page = await ctx.env.ASSETS.fetch(new URL('/login', url));
  return new Response(page.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
`;
}

// 올릴 폴더 만들기. 차트 정의(definition)처럼 화면에 필요 없는 값은 뺀다.
export async function buildViewer(root) {
  const out = path.join(root, '.viewer'), pub = path.join(root, 'public'), dataDir = path.join(root, 'data');
  const password = process.env.APP_PASSWORD || '';
  if (!password) throw new Error('.env에 APP_PASSWORD가 없습니다. 비밀번호 없이 외부에 올리지 않습니다.');
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(path.join(out, 'data'), { recursive: true });
  await fs.mkdir(path.join(out, 'functions'), { recursive: true });
  await fs.copyFile(path.join(pub, 'index.html'), path.join(out, 'index.html'));
  await fs.copyFile(path.join(pub, 'login.html'), path.join(out, 'login.html'));
  await fs.copyFile(path.join(root, 'viewer', 'runtime.js'), path.join(out, 'runtime.js'));
  const read = async c => { try { return JSON.parse(await fs.readFile(path.join(dataDir, `${c}.json`), 'utf8')); } catch { return {}; } };
  for (const c of ['analyses', 'analysisData', 'improvements']) await fs.writeFile(path.join(out, 'data', `${c}.json`), JSON.stringify(await read(c)));
  const sources = await read('sources');
  for (const s of Object.values(sources)) { delete s.definition; delete s.platform_definition; (s.extra_charts || []).forEach(x => delete x.definition); }
  await fs.writeFile(path.join(out, 'data', 'sources.json'), JSON.stringify(sources));
  const settings = await read('settings');
  // 팀 맥락과 종합 진단 리포트만 올린다(갱신 상태 같은 내부 값은 빼고)
  await fs.writeFile(path.join(out, 'data', 'settings.json'), JSON.stringify(Object.fromEntries(['team', 'uxReport'].filter(k => settings[k]).map(k => [k, settings[k]]))));
  await fs.writeFile(path.join(out, 'data', '_meta.json'), JSON.stringify({ publishedAt: Date.now() }));
  await fs.writeFile(path.join(out, 'functions', '_middleware.js'), middleware(password));
  await fs.writeFile(path.join(out, '_headers'), '/*\n  X-Robots-Tag: noindex\n  Referrer-Policy: same-origin\n');
  return out;
}

const job = { running: false, lastRunAt: null, url: null, error: null };
export const publishJob = () => ({ ...job, project: pagesProject() });

export async function publishViewer(root, log = console.log) {
  if (job.running) return publishJob();
  Object.assign(job, { running: true, error: null });
  try {
    const who = await wrangler(['whoami'], { cwd: root, timeout: 3 * 60 * 1000 });
    if (who.code !== 0 || /not authenticated|You are not logged in/i.test(who.out)) throw new Error('Cloudflare 로그인이 필요합니다. 터미널에서 npx wrangler login 을 한 번 실행하세요.');
    const dir = await buildViewer(root);
    const project = pagesProject();
    // 처음 한 번은 프로젝트를 만든다(이미 있으면 실패해도 괜찮다)
    await wrangler(['pages', 'project', 'create', project, '--production-branch', 'main'], { cwd: root, timeout: 3 * 60 * 1000 });
    // functions/(비밀번호 확인)는 wrangler를 실행한 폴더 기준으로 찾으므로, 올릴 폴더 안에서 실행한다
    const dep = await wrangler(['pages', 'deploy', '.', '--project-name', project, '--branch', 'main', '--commit-dirty=true'], { cwd: dir });
    if (dep.code === 0 && !/functions|Worker/i.test(dep.out)) throw new Error('비밀번호 확인(functions)이 함께 올라가지 않았습니다. 다시 시도하세요.');
    if (dep.code !== 0) throw new Error(`올리기 실패: ${dep.out.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300)}`);
    job.url = `https://${project}.pages.dev`;
    job.lastRunAt = Date.now();
    log(`[클라우드 사본] 올렸습니다: ${job.url}`);
  } catch (e) {
    job.error = String(e && e.message || e).slice(0, 300);
    log(`[클라우드 사본] ${job.error}`);
  } finally { job.running = false; }
  return publishJob();
}
