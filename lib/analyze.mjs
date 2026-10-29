// 대시보드 카드의 AI 해석을 서버에서 한꺼번에 돌린다.
// 화면에서 카드마다 "AI 해석"을 누르는 것과 같은 프롬프트(LOGIC 블록의 analysisPrompt)를 쓰고,
// 결과는 화면이 저장하는 것과 같은 자리(analysisData.analysis, analyses.headline)에 넣는다.
import { withTimeKpi } from './timekpi.mjs';
import { runClaude } from './ai.mjs';

const CONCURRENCY = Math.min(Math.max(parseInt(process.env.ANALYZE_CONCURRENCY, 10) || 3, 1), 6);

// 화면 runtime.js의 sample.json과 같은 방식으로 JSON 객체를 읽는다.
function parseJsonObject(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('AI 응답에서 JSON을 찾지 못했습니다.');
  return JSON.parse(text.slice(s, e + 1));
}

const groupKey = m => `${m.type}|${String(m.title || '').trim().toLowerCase()}`;

// 분모(첫 단계 사람 수)가 SKIP_ANALYZE_BELOW(기본 10)명 미만인 저장본은 AI 해석을 건너뛴다. 해석해도 결론이 "표본 부족"뿐이라 호출만 든다. 0이면 건너뛰지 않는다. 메인 KPI는 늘 해석한다.
const SKIP_BELOW = (() => { const v = parseInt(process.env.SKIP_ANALYZE_BELOW, 10); return Number.isFinite(v) && v >= 0 ? v : 10; })();

// 지표(같은 종류·이름)마다 가장 최근 저장본 중 아직 해석이 없는 것
export async function pendingAnalyses(store) {
  // 숨긴 지표와 자동 갱신을 끈 지표는 AI 해석도 새로 만들지 않는다
  const hidden = new Set((await store.list('sources')).filter(x => x.data.hidden || x.data.active === false).map(x => groupKey(x.data)));
  const latest = new Map();
  for (const { id, data: a } of await store.list('analyses')) {
    const k = groupKey(a), t = a.period && a.period.end ? a.period.end : '';
    const p = latest.get(k);
    if (!p || t > p.t || (t === p.t && (a.savedAt || 0) > (p.a.savedAt || 0))) latest.set(k, { id, a, t });
  }
  return [...latest.values()].filter(x => !x.a.hasAnalysis && !x.a.analysisSkipped && !x.a.hidden && !hidden.has(groupKey(x.a))).map(x => ({ id: x.id, title: x.a.title }));
}

export async function analyzeOne(store, L, id, { signal, promptOnly = false } = {}) {
  const meta = await store.get('analyses', id);
  const data = await store.get('analysisData', id);
  if (!meta || !data) throw new Error('저장본을 찾지 못했습니다.');
  const table = L.buildTable(L.parseCSV(data.csv || ''));
  if (!table) throw new Error('저장된 표를 읽지 못했습니다.');
  const it = L.INTERPRETERS[data.type || meta.type](table);
  if (it.error) throw new Error(it.error);
  if (data.measure) it.measure = data.measure;
  const segIdx = Number.isInteger(data.segIdx) ? data.segIdx : 0;
  const ctx = data.context || {};
  const team = await store.get('settings', 'team');
  const period = meta.period ? ` (데이터 기간 ${meta.period.start} ~ ${meta.period.end})` : '';
  // 지표 정의: 같은 종류·이름의 자동 갱신 차트에 적어 둔 정의
  const sources = (await store.list('sources')).map(x => x.data);
  const src = sources.find(x => groupKey(x) === groupKey(meta));
  if (src && src.pin) it.pin = src.pin; // 대표 줄 고정
  if (src && src.cardSingle) it.cardSingle = true; // 카드 요약을 다시 만들 때도 같은 모양을 지킨다
  // 직전 비교: 같은 지표 저장본을 기간 순으로 세워, 같은 길이·겹치지 않는 직전 것과 비교한다(화면과 같은 규칙)
  const group = (await store.list('analyses')).map(x => ({ id: x.id, ...x.data })).filter(x => groupKey(x) === groupKey(meta))
    .sort((a, b) => ((a.period && a.period.end) || '').localeCompare((b.period && b.period.end) || '') || (a.savedAt || 0) - (b.savedAt || 0));
  const i = group.findIndex(x => x.id === id);
  const cur = i >= 0 ? group[i] : { id, ...meta };
  // 이 지표에 연결된 개선 배포 시점(개선 전 저장본으로 잇는다). 변화를 배포와 연결해 보게 해 준다.
  const releases = (await store.list('improvements')).map(x => x.data)
    .filter(x => x && x.releaseDate && (group.some(g => g.id === x.beforeSnapId) || String(x.metric || '').trim() === String(meta.title || '').trim()));
  const comparison = L.comparisonText(cur, i >= 0 ? L.comparablePrev(group, i) : null, group.slice(0, i + 1).filter(x => x === cur || L.sameMetric(cur, x)), releases);
  // 플랫폼별(전체·Android·iOS·PC) 데이터가 있으면 같이 본다
  const platform = [L.platformBrief(data.type || meta.type, data.platformCsv, data.measure), ...Object.entries(data.extraPlatformCsv || {}).map(([k, csv]) => { const b = L.platformBrief(data.type || meta.type, csv, data.measure); return b ? `(${k})\n${b}` : ''; })].filter(Boolean).join('\n');
  const prompt = L.analysisPrompt({
    type: data.type || meta.type, it, segIdx, table, team,
    svc: ctx.service || `${meta.title}${period}`, goal: ctx.goal || '',
    definition: (src && src.definition_text) || '', caution: L.cautionText(src && src.guide), comparison, platform,
    extras: L.extraBrief(data.extraCsv),
    available: sources.filter(x => !x.hidden && groupKey(x) !== groupKey(meta)).map(x => x.title),
  }) + '\n\n설명이나 코드 블록 없이 JSON 객체 하나만 출력하세요.';
  if (promptOnly) return prompt; // 검증용: 프롬프트만 돌려준다
  const out = await runClaude(prompt, { signal });
  const analysis = L.normalizeAnalysis(parseJsonObject(out.text));
  if (!analysis.findings.length && !analysis.improvements.length) throw new Error('AI 응답을 리포트 형식으로 읽지 못했습니다.');
  // 데이터에서 찾지 못한 수치를 표시해 둔다(리포트에 '확인 필요한 수치'로 보임)
  analysis.unverified = L.unverifiedNumbers(analysis, [L.dataBrief(it, segIdx), L.rawExcerpt(table), comparison, platform, L.extraBrief(data.extraCsv)]);
  const at = Date.now();
  // set이 아니라 update: 해석하는 사이 갱신이 이 저장본을 지웠다면 되살리지 않고 실패로 둔다
  await store.update('analysisData', id, L.clean({ analysis, analysisAt: at }));
  await store.update('analyses', id, L.clean({ headline: analysis.headline, hasAnalysis: true, reusedAnalysis: false, analysisSkipped: false, summary: withTimeKpi(L.snapshotSummary(it, segIdx), data.extraCsv), updatedAt: at }));
  return analysis;
}

// 한 번에 하나만 돈다. 진행 상황은 job으로 확인한다.
const job = { running: false, total: 0, done: 0, failed: 0, reused: 0, skipped: 0, current: [], startedAt: null, finishedAt: null, errors: [] };
export const analyzeJob = () => ({ ...job, current: job.current.slice(), errors: job.errors.slice(-10) });

async function trySkipSmall(store, L, id) {
  if (!SKIP_BELOW) return false;
  const meta = await store.get('analyses', id);
  const n = meta && meta.summary ? meta.summary.metricN : null;
  if (typeof n !== 'number' || n >= SKIP_BELOW) return false;
  const src = (await store.list('sources')).map(x => x.data).find(x => groupKey(x) === groupKey(meta));
  if (src && src.main) return false;
  await store.update('analyses', id, L.clean({ analysisSkipped: 'small_n', hasAnalysis: false, headline: `분모가 ${n}명이라 표본이 너무 작아 AI 해석을 건너뛰었어요. (${SKIP_BELOW}명 이상일 때 해석해요)`, updatedAt: Date.now() }));
  return true;
}

// 직전과 값이 거의 같은 지표는 AI를 부르지 않고 직전 해석을 이어 쓴다(REUSE_ANALYSIS=off로 끔). 메인 KPI는 늘 새로 해석한다.
const REUSE = process.env.REUSE_ANALYSIS !== 'off';
// 값이 이만큼 이내로 같으면 재사용: 비율 지표는 %p(REUSE_PCT_POINTS), 그 밖은 상대 비율(REUSE_REL)
const numEnv = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
const REUSE_PP = numEnv('REUSE_PCT_POINTS', 1), REUSE_REL = numEnv('REUSE_REL', 0.05);
const overlaps = (a, b) => !!(a && b && a.start <= b.end && b.start <= a.end);
async function tryReuse(store, L, id) {
  const meta = await store.get('analyses', id), data = await store.get('analysisData', id);
  if (!meta || !data || !meta.summary || typeof meta.summary.metric !== 'number') return false;
  const sources = (await store.list('sources')).map(x => x.data);
  const src = sources.find(x => groupKey(x) === groupKey(meta));
  if (!src || src.main) return false;
  const group = (await store.list('analyses')).map(x => ({ id: x.id, ...x.data })).filter(x => groupKey(x) === groupKey(meta))
    .sort((a, b) => ((a.period && a.period.end) || '').localeCompare((b.period && b.period.end) || '') || (a.savedAt || 0) - (b.savedAt || 0));
  const i = group.findIndex(x => x.id === id);
  let prev = i > 0 ? L.comparablePrev(group, i) : null;
  // 직전에 해석이 없으면, 같은 지표에서 기간이 겹치는 해석 있는 저장본(같은 회차를 날짜만 달리 다시 받은 것)을 쓴다
  if (!prev || !prev.hasAnalysis) prev = group.filter(x => x.id !== id && x.hasAnalysis && x.sourceId === meta.sourceId && overlaps(x.period, meta.period)).pop() || prev;
  if (!prev || !prev.hasAnalysis || !prev.summary || typeof prev.summary.metric !== 'number') return false;
  const a = meta.summary.metric, b = prev.summary.metric, pct = meta.summary.metricUnit === '%';
  const small = pct ? Math.abs(a - b) < REUSE_PP : Math.abs(a - b) <= Math.abs(b) * REUSE_REL;
  if (!small) return false;
  const pd = await store.get('analysisData', prev.id);
  if (!pd || !pd.analysis) return false;
  // 직전 글을 그대로 가져오면 본문 숫자는 직전 기간 값이다. 이번 기간 재료로 숫자 검사를 다시 돌려
  // 어긋난 숫자를 '확인 필요한 수치'에 남긴다. 너무 많이 어긋나면 재사용하지 않고 새로 해석한다.
  const analysis = { ...pd.analysis };
  analysis.unverified = reuseUnverified(L, meta, data, analysis);
  if (analysis.unverified.length > REUSE_STALE_MAX) return false;
  const at = Date.now();
  await store.update('analysisData', id, L.clean({ analysis, analysisAt: at, analysisReusedFrom: prev.id }));
  await store.update('analyses', id, L.clean({
    headline: prev.headline || '', hasAnalysis: true, reusedAnalysis: true,
    analysisReusedPeriod: prev.period || null, analysisReusedStale: analysis.unverified.length, updatedAt: at,
  }));
  return true;
}
// 재사용한 글의 숫자를 이번 기간 재료와 대조한다. 모델을 부르지 않는다.
const REUSE_STALE_MAX = numEnv('REUSE_STALE_MAX', 3);
function reuseUnverified(L, meta, data, analysis) {
  try {
    const table = L.buildTable(L.parseCSV(data.csv || ''));
    if (!table) return [];
    const it = L.INTERPRETERS[data.type || meta.type](table);
    if (it.error) return [];
    if (data.measure) it.measure = data.measure;
    const segIdx = Number.isInteger(data.segIdx) ? data.segIdx : 0;
    const platform = L.platformBrief(data.type || meta.type, data.platformCsv, data.measure);
    return L.unverifiedNumbers(analysis, [L.dataBrief(it, segIdx), L.rawExcerpt(table), platform, L.extraBrief(data.extraCsv)]);
  } catch { return []; }
}

export async function analyzeAll(store, L, log = console.log) {
  if (job.running) return analyzeJob();
  const list = await pendingAnalyses(store);
  Object.assign(job, { running: true, total: list.length, done: 0, failed: 0, reused: 0, skipped: 0, current: [], startedAt: Date.now(), finishedAt: null, errors: [] });
  const queue = list.slice();
  const worker = async () => {
    for (let x; (x = queue.shift());) {
      job.current.push(x.title);
      try { if (await trySkipSmall(store, L, x.id)) job.skipped++; else if (REUSE && await tryReuse(store, L, x.id)) job.reused++; else await analyzeOne(store, L, x.id, { signal: AbortSignal.timeout(5 * 60 * 1000) }); job.done++; }
      catch (e) { job.failed++; job.errors.push({ title: x.title, error: String(e && e.message || e).slice(0, 200) }); }
      finally { job.current.splice(job.current.indexOf(x.title), 1); }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker)); }
  finally {
    job.running = false; job.finishedAt = Date.now();
    if (list.length) log(`[AI 해석] ${job.done}/${job.total}개 완료${job.reused ? ` (직전 해석 이어 씀 ${job.reused}개)` : ''}${job.skipped ? ` (표본 작아 건너뜀 ${job.skipped}개)` : ''}${job.failed ? `, ${job.failed}개 실패` : ''}`);
  }
  return analyzeJob();
}
