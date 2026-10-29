// 자동 갱신 차트(sources)를 Amplitude에서 가져와 대시보드 저장본으로 넣는다.
import { withTimeKpi } from './timekpi.mjs';
import { buildWrites } from './logic.mjs';
import { fetchChartCsv, fetchReady, editIdOf, excludeResume } from './amplitude.mjs';
import { usageReset, usageText } from './ai.mjs';
import { analyzeJob } from './analyze.mjs';

// 자동 갱신 차트의 기본 데이터 기간(일)
export const DEFAULT_DAYS = 7;
// 직접 정한 날짜 범위 { start, end } (YYYY-MM-DD)
const validRange = r => !!(r && /^\d{4}-\d{2}-\d{2}$/.test(r.start || '') && /^\d{4}-\d{2}-\d{2}$/.test(r.end || '') && r.start <= r.end);
const daysOf = d => Math.min(Math.max(parseInt(d, 10) || DEFAULT_DAYS, 1), 366);

const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 차트에 저장된 기간이 '최근 N일'이라고 보고, 어제까지 N일을 데이터 기간으로 기록한다.
export function periodFor(days, now = new Date()) {
  const n = daysOf(days);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (n - 1));
  return { start: isoDay(start), end: isoDay(end) };
}

// 주 단위(interval=7) 차트: Amplitude의 한 칸은 월요일에 시작하는 한 주이고 덜 끝난 주는 뺀다.
// 그래서 "수~화"로 요청해도 실제 값은 그 앞의 월~일 한 주다. 요청 기간을 처음부터 그 주(월~일)로 맞춰, 표시 기간과 데이터를 일치시킨다.
export function alignWeek(r, days = 7) {
  const [y, m, d] = r.end.split('-').map(Number);
  const e = new Date(y, m - 1, d);
  e.setDate(e.getDate() - e.getDay()); // 그 날 이하의 가장 가까운 일요일
  const weeks = Math.max(1, Math.ceil(daysOf(days) / 7));
  const s = new Date(e.getFullYear(), e.getMonth(), e.getDate() - (weeks * 7 - 1));
  return { start: isoDay(s), end: isoDay(e) };
}

// 기간을 정하는 기준 시각. 같은 회차(수요일 10시 등)면 며칠 뒤에 다시 갱신해도 같은 기간이 되게 한다(겹치는 기간 저장본·해석 중복 방지).
// ANCHOR_WEEKLY=off 면 예전처럼 지금 기준(어제까지 N일).
const anchorOf = opts => opts.anchor ? new Date(opts.anchor) : process.env.ANCHOR_WEEKLY === 'off' ? new Date() : lastScheduledSlot();

// opts.range: 이번 한 번만 이 날짜 범위로 가져온다(이전 기간 채우기). 이때는 차트의 갱신 상태(마지막 갱신 등)를 건드리지 않는다.
const PLATFORM_EVERY_DAYS = Number(process.env.PLATFORM_EVERY_DAYS || 21);
// 저장된 차트의 정의를 받아 두고 다시 쓰는 기간(일). 지나면 다음 자동 갱신 때 다시 받는다(Amplitude에서 차트를 고쳤을 수 있어서).
const DEF_TTL_DAYS = Number(process.env.DEF_TTL_DAYS || 21);
// 갱신 진행 상황: 한 번에 여러 차트를 받는 동안(runAll·runMany) 몇 개째인지 화면에 보여 준다.
const rj = { running: false, total: 0, done: 0, failed: 0, current: [], startedAt: null, finishedAt: null, errors: [] };
export const refreshJob = () => ({ ...rj, current: rj.current.slice(), errors: rj.errors.slice(-10) });
function jobStart(total) { Object.assign(rj, { running: true, total, done: 0, failed: 0, current: [], startedAt: Date.now(), finishedAt: null, errors: [] }); }
function jobEnd() { rj.running = false; rj.finishedAt = Date.now(); }
export async function runSource(store, L, id, opts = {}) {
  const s0 = await store.get('sources', id), name = (s0 && s0.title) || id;
  rj.current.push(name);
  try {
    const r = await runSourceOnce(store, L, id, opts);
    if (rj.running && !opts.range) { if (r && r.ok) rj.done++; else { rj.failed++; rj.errors.push({ title: name, error: String((r && r.error) || '').slice(0, 120) }); } }
    return r;
  } catch (e) { if (rj.running) { rj.failed++; rj.errors.push({ title: name, error: String(e && e.message || e).slice(0, 120) }); } throw e; }
  finally { const i = rj.current.indexOf(name); if (i >= 0) rj.current.splice(i, 1); }
}
async function runSourceOnce(store, L, id, opts = {}) {
  const src = await store.get('sources', id);
  if (!src) throw new Error('자동 갱신 차트를 찾지 못했습니다.');
  const startedAt = Date.now();
  try {
    // Claude Code 커넥터로 가져올 때는 30초 안팎 걸려서 넉넉히 기다린다.
    // 저장하지 않은 차트(/chart/new/…)의 정의는 바뀌지 않으니 한 번 받아 두고 다시 쓴다.
    const once = validRange(opts.range) ? opts.range : null;
    // 상대 기간("최근 N일") 대신 늘 날짜를 정해(어제까지 N일) 가져온다. 오늘 일부가 섞이지 않고, 표시 기간과 데이터가 정확히 맞는다.
    const range = once || (validRange(src.range) ? src.range : (src.interval === 7 ? alignWeek(periodFor(src.days, anchorOf(opts)), src.days) : periodFor(src.days, anchorOf(opts))));
    // interval: 차트의 집계 단위를 바꿔 가져온다(예: 7 = 주 단위). 일별 중앙값을 다시 평균하면 틀리므로,
    // 소요 시간 같은 값 지표는 기간 전체를 한 칸으로 받아 그 기간의 중앙값을 그대로 쓴다.
    // 저장하지 않은 차트는 정의가 안 바뀌니 늘 보관본을 쓰고, 저장된 차트는 자동 갱신에서 DEF_TTL_DAYS 안일 때만 쓴다.
    const savedChart = !editIdOf(src.chart);
    const defFresh = !!src.definition && (!savedChart || (!!opts.auto && Date.now() - (src.definitionAt || 0) < DEF_TTL_DAYS * 864e5));
    const usable = defFresh ? src.definition : null;
    const def = usable && src.interval ? { ...usable, params: { ...usable.params, interval: src.interval } } : usable;
    const fetched = await fetchChartCsv(src.chart, {
      signal: AbortSignal.timeout(240000), days: daysOf(src.days), range, definition: def,
      seriesLabels: src.series_labels || null, overall: !!src.wholeRange, // wholeRange: 응답의 overallSeries(기간 전체 값)로 수~화 같은 임의의 7일을 한 덩어리로 읽는다
      patchDefinition: src.excludeResume ? excludeResume : null, // 시작 단계에서 자동 재개 전송을 뺀다
    });
    const { definition } = fetched;
    // 본 차트와 플랫폼별 차트가 같은 링크(전체·Android·iOS·PC 줄이 한 차트에 있음)면, 본 지표는 "전체" 줄만 쓰고 전체 표는 플랫폼 표로 붙인다.
    const sameChart = !!src.platform_chart && src.platform_chart === src.chart;
    const cleanCsv = text => text.split('\n').map(l => l.replace(/^("?)\d+-/, '$1')).join('\n');
    let csv = fetched.csv, fullCsv = null;
    if (sameChart) {
      fullCsv = cleanCsv(fetched.csv);
      const lines = fullCsv.split('\n');
      csv = [lines[0], ...lines.slice(1).filter(l => /;\s*전체"?,/.test(l)).map(l => l.replace(/;\s*전체("?),/, '$1,'))].join('\n');
    }
    if (definition && (!src.definition || (savedChart && !defFresh))) await store.update('sources', id, { definition, definitionAt: Date.now() });
    // pivotRatio: 「…, 그룹, True/False」처럼 예·아니오로 나뉜 건수를 그룹별 비율(예 ÷ (예 + 아니오))로 바꾼다.
    // 예: 완료 순간 화면을 보고 있었나(page_visible) → 채팅 90%·슬라이드 91%. (none)은 판단할 수 없어 분모에서 뺀다.
    if (src.pivotRatio && csv) csv = pivotRatioCsv(csv, src.pivotRatio);
    const out = buildWrites(L, {
      title: src.title, type: src.type, csv, period: range, measure: src.measure || null,
      sourceId: id, pin: src.pin || undefined, segIdx: Number.isInteger(src.segIdx) ? src.segIdx : undefined, cardSingle: !!src.cardSingle,
    });
    // 같은 차트·같은 기간 저장본이 이미 있으면 새 것으로 바꾼다(다시 갱신해도 중복이 쌓이지 않게). 트래커에 연결된 저장본은 남긴다.
    const linked = new Set((await store.list('improvements')).flatMap(i => [i.data.beforeSnapId, i.data.afterSnapId]).filter(Boolean));
    const olds = (await store.list('analyses')).filter(a => a.data.sourceId === id && a.data.period && a.data.period.start === range.start && a.data.period.end === range.end && !linked.has(a.id));
    for (const w of out.writes) await store.set(w.collection, w.id, w.data);
    for (const o of olds) { await store.remove('analyses', o.id); await store.remove('analysisData', o.id); }
    // 같은 카드에 붙인 추가 값 차트(예: 소요 시간 p75·p90): 같은 기간·같은 집계 단위로 가져와 붙인다
    if (Array.isArray(src.extra_charts) && src.extra_charts.length) {
      const extraCsv = {};
      for (const x of src.extra_charts) {
        try {
          const xd = x.definition && src.interval ? { ...x.definition, params: { ...x.definition.params, interval: src.interval } } : (x.definition || null);
          const r = await fetchChartCsv(x.chart, { signal: AbortSignal.timeout(240000), days: daysOf(src.days), range, definition: xd, overall: !!src.wholeRange });
          if (r.definition && !x.definition) { x.definition = r.definition; await store.update('sources', id, { extra_charts: src.extra_charts }); }
          extraCsv[x.label] = r.csv;
        } catch (e) { /* 추가 차트가 실패해도 본 지표는 둔다 */ }
      }
      if (Object.keys(extraCsv).length) await store.update('analysisData', out.id, { extraCsv });
      // 전환 시간 차트(중앙값 ms)는 카드 숫자로 붙인다
      const a = await store.get('analyses', out.id);
      if (a && a.summary) await store.update('analyses', out.id, { summary: withTimeKpi(a.summary, extraCsv) });
    }
    // 플랫폼별 차트(전체·Android·iOS·PC)가 있으면 같은 기간으로 한 번 더 가져와 그 저장본에 붙인다.
    // 카드 값은 본 차트로만 정하고, 플랫폼 쪽이 실패해도 본 지표는 성공으로 둔다.
    if (sameChart && fullCsv) {
      await store.update('analysisData', out.id, { platformCsv: fullCsv });
    } else if (src.platform_chart && !(opts.auto && !src.main && src.platformFetchedAt && Date.now() - src.platformFetchedAt < PLATFORM_EVERY_DAYS * 864e5)) {
      // 일괄 갱신(매주 자동·모두 갱신)에서는 메인 KPI가 아닌 지표의 플랫폼별을 PLATFORM_EVERY_DAYS일(기본 21일)에 한 번만 받는다. 지표 하나만 갱신하면 늘 받는다.
      try {
        const pi = src.platform_interval || src.interval;
        const pdef = src.platform_definition && pi ? { ...src.platform_definition, params: { ...src.platform_definition.params, interval: pi } } : (src.platform_definition || null);
        const p = await fetchChartCsv(src.platform_chart, { signal: AbortSignal.timeout(240000), days: daysOf(src.days), range, definition: pdef, seriesLabels: src.series_labels || null, overall: !!src.wholeRange });
        await store.update('analysisData', out.id, { platformCsv: p.csv });
        await store.update('sources', id, { platformFetchedAt: Date.now() });
        if (p.definition && editIdOf(src.platform_chart) && !src.platform_definition) await store.update('sources', id, { platform_definition: p.definition });
        if (!once) await store.update('sources', id, { platformError: null });
      } catch (e) {
        if (!once) await store.update('sources', id, { platformError: String(e && e.message || e).slice(0, 200) }).catch(() => {});
      }
    }
    if (!once) await store.update('sources', id, { lastRunAt: startedAt, lastStatus: 'ok', lastError: null, lastErrorCode: null, lastAnalysisId: out.id, updatedAt: Date.now() });
    return { ok: true, id: out.id };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 300);
    // 사용자 0명(no_data)은 실패와 구분해 '데이터 없음' 카드로 보여준다
    if (!opts.range) await store.update('sources', id, { lastRunAt: startedAt, lastStatus: 'error', lastError: msg, lastErrorCode: (e && e.code) || null, updatedAt: Date.now() }).catch(() => {});
    return { ok: false, error: msg, code: (e && e.code) || null };
  }
}

// 이전 기간 채우기: 켜진 차트마다 지금 설정한 기간 바로 앞의 같은 길이 기간을 한 번씩 가져와 저장한다.
// 같은 기간 저장본이 이미 있으면 건너뛴다. 진행 상황은 backfillJob()으로 본다.
const bf = { running: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [] };
export const backfillJob = () => ({ ...bf, errors: bf.errors.slice(-10) });
const shiftDay = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return isoDay(new Date(y, m - 1, d + n)); };
export function previousRange(src, now = new Date()) {
  const cur = validRange(src.range) ? src.range : periodFor(src.days, now);
  const len = Math.round((new Date(cur.end) - new Date(cur.start)) / 864e5) + 1;
  return { start: shiftDay(cur.start, -len), end: shiftDay(cur.start, -1) };
}
export async function runBackfill(store, L) {
  if (bf.running) return backfillJob();
  const list = (await store.list('sources')).filter(s => s.data.active !== false);
  const have = new Set((await store.list('analyses')).map(a => `${a.data.sourceId}|${a.data.period && a.data.period.start}|${a.data.period && a.data.period.end}`));
  Object.assign(bf, { running: true, total: list.length, done: 0, failed: 0, skipped: 0, errors: [] });
  try {
    for (const s of list) {
      const r = previousRange(s.data);
      if (have.has(`${s.id}|${r.start}|${r.end}`)) { bf.skipped++; continue; }
      const out = await runSource(store, L, s.id, { range: r });
      if (out.ok) bf.done++; else { bf.failed++; bf.errors.push({ title: s.data.title, error: out.error }); }
    }
  } finally { bf.running = false; }
  return backfillJob();
}

// 저장본 보존: 같은 자동 갱신 차트의 저장본이 KEEP_SNAPSHOTS(기본 26, 약 반년)개를 넘으면 오래된 것부터 지운다. 개선 트래커에 연결된 저장본은 늘 남긴다.
// KEEP_SNAPSHOTS=0 이면 지우지 않는다.
export async function pruneSnapshots(store, keep = Number(process.env.KEEP_SNAPSHOTS ?? 26), log = console.log) {
  if (!(keep > 0)) return 0;
  const linked = new Set((await store.list('improvements')).flatMap(i => [i.data.beforeSnapId, i.data.afterSnapId]).filter(Boolean));
  const by = new Map();
  for (const { id, data: a } of await store.list('analyses')) { if (a.sourceId && a.period) (by.get(a.sourceId) || by.set(a.sourceId, []).get(a.sourceId)).push({ id, a }); }
  let n = 0;
  for (const list of by.values()) {
    list.sort((x, y) => (y.a.period.end || '').localeCompare(x.a.period.end || '') || (y.a.savedAt || 0) - (x.a.savedAt || 0));
    for (const { id } of list.slice(keep)) { if (linked.has(id)) continue; await store.remove('analyses', id); await store.remove('analysisData', id); n++; }
  }
  if (n) log(`[저장본 정리] 차트마다 최근 ${keep}개만 남기고 ${n}개를 지웠습니다.`);
  return n;
}

// opts.since: 이 시각 이후에 이미 성공한 차트는 건너뛴다(자동 갱신이 중간에 끊겼다가 이어서 할 때)
export async function runAll(store, L, opts = {}) {
  const list = (await store.list('sources')).filter(s => s.data.active !== false
    && !(opts.since && s.data.lastStatus === 'ok' && (s.data.lastRunAt || 0) >= opts.since));
  const results = [];
  jobStart(list.length);
  const anchor = opts.anchor || anchorOf({}); // 차트마다 "지금"으로 다시 계산하지 않고 한 번만 정한다
  // Amplitude는 동시 요청 수를 제한하므로 하나씩 차례로 가져온다.
  for (const s of list) {
    // 커넥터 로그인이 만료됐으면 나머지도 모두 실패하니 더 시도하지 않는다(차트마다 claude 세션을 띄우는 낭비 방지)
    if (results.some(r => r.code === 'session_expired') || results.slice(-2).filter(r => r.code === 'no_tool').length === 2) { results.push({ id: s.id, title: s.data.title, ok: false, code: 'skipped', error: '커넥터를 쓸 수 없어(로그인 만료 등) 건너뛰었습니다.' }); continue; }
    results.push({ id: s.id, title: s.data.title, ...(await runSource(store, L, s.id, { auto: true, anchor })) });
  }
  jobEnd();
  await pruneSnapshots(store).catch(e => console.error('[저장본 정리]', e));
  return results;
}

// 고른 차트들만 차례로 갱신한다(예: 기간이 안 맞는 것만 다시). 진행 상황은 refreshJob()으로 본다.
export async function runMany(store, L, ids, opts = {}) {
  if (rj.running) return refreshJob();
  jobStart(ids.length);
  const anchor = opts.anchor || anchorOf({});
  try { for (const id of ids) await runSource(store, L, id, { auto: true, anchor }).catch(() => {}); }
  finally { jobEnd(); }
  return refreshJob();
}

// 자동 갱신 요일·시각(서버 시간대). 기본은 수요일 오전 10시(수요일 보고용으로 지난 수~화 7일치가 준비되도록).
// .env의 REFRESH_DAY(0=일 … 3=수 … 6=토), REFRESH_HOUR(0~23)로 바꾼다.
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const intEnv = (k, d, lo, hi) => { const v = parseInt(process.env[k], 10); return Number.isInteger(v) && v >= lo && v <= hi ? v : d; };
export const refreshDay = () => intEnv('REFRESH_DAY', 3, 0, 6);
export const refreshHour = () => intEnv('REFRESH_HOUR', 10, 0, 23);
export const scheduleText = () => `매주 ${DAY_NAMES[refreshDay()]}요일 ${refreshHour() < 12 ? '오전' : '오후'} ${refreshHour() % 12 || 12}시`;
// 가장 최근에 지난 자동 갱신 시각
export function lastScheduledSlot(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), refreshHour(), 0, 0, 0);
  const back = (d.getDay() - refreshDay() + 7) % 7; // 갱신 요일까지 며칠 전인지
  d.setDate(d.getDate() - back);
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}
export const nextScheduledSlot = (now = new Date()) => { const d = lastScheduledSlot(now); d.setDate(d.getDate() + 7); return d; };

// 서버가 켜져 있는 동안 10분마다 확인해서, 이번 주 갱신 시각의 갱신을 아직 안 했으면 실행한다.
// 그 시각에 꺼져 있었다면 다음에 켰을 때 한 번 따라잡는다.
// 회차(slot)마다 단계를 기록한다: refresh(차트 갱신) → after(이어지는 작업들) → done.
// 서버가 중간에 꺼졌다 켜지면 끝나지 않은 단계부터 이어서 한다. 이미 받은 차트·끝난 작업은 건너뛴다.
// afterRun(steps): steps.done(name)으로 끝난 작업인지 묻고, steps.mark(name)으로 끝났다고 기록한다.
export function startScheduler(store, L, log = console.log, afterRun = null) {
  let running = false;
  // 실패한 차트만 RETRY_EVERY_MIN분마다 최대 RETRY_MAX번 다시 받는다(0이면 재시도 없음). 성공한 차트는 since로 건너뛴다.
  const RETRY_MAX = intEnv('RETRY_MAX', 3, 0, 10), RETRY_EVERY_MS = intEnv('RETRY_EVERY_MIN', 60, 5, 1440) * 60000;
  const getSt = async () => (await store.get('settings', 'refresh')) || {};
  const saveSt = async patch => store.set('settings', 'refresh', Object.assign({}, await getSt(), patch));
  const tick = async () => {
    if (running || !(await fetchReady())) return;
    const slot = lastScheduledSlot().getTime();
    let st = await getSt();
    // 예전 형식(단계 기록 없음): 이번 회차를 이미 돌렸으면 끝난 것으로 본다
    if (!st.slot && (st.lastAutoRun || 0) >= slot) { await saveSt({ slot, stage: 'done', doneSteps: [] }); return; }
    if (st.slot === slot && st.stage === 'done') return;
    const any = (await store.list('sources')).some(s => s.data.active !== false);
    if (!any) return;
    running = true;
    try {
      if (st.slot !== slot || st.stage === 'refresh' || !st.stage) {
        if (st.slot !== slot) { usageReset(); await saveSt({ slot, stage: 'refresh', doneSteps: [], startedAt: Date.now(), attempts: 0, retryAt: 0 }); st = await getSt(); }
        else if (st.retryAt && Date.now() < st.retryAt) return; // 재시도 대기 중
        const results = await runAll(store, L, { since: slot, anchor: slot });
        const failed = results.filter(r => !r.ok && r.code !== 'no_data'); // 사용자 0명(no_data)은 재시도해도 같다
        const attempts = (st.attempts || 0) + 1, retry = failed.length > 0 && attempts <= RETRY_MAX;
        await saveSt({ stage: retry ? 'refresh' : 'after', attempts, retryAt: retry ? Date.now() + RETRY_EVERY_MS : 0, lastAutoRun: Date.now(), lastResults: results.map(r => ({ id: r.id, ok: r.ok, code: r.code || null })) });
        log(`[자동 갱신] ${results.filter(r => r.ok).length}/${results.length}개 차트를 가져왔습니다${st.slot === slot && attempts > 1 ? ' (다시 시도)' : ''}.`);
        if (retry) { log(`[자동 갱신] 실패 ${failed.length}개는 ${Math.round(RETRY_EVERY_MS / 60000)}분 뒤 다시 받습니다(${attempts}/${RETRY_MAX}).`); return; }
      } else log('[자동 갱신] 끊겼던 이후 작업을 이어서 합니다.');
      if (afterRun) {
        const steps = {
          done: async name => ((await getSt()).doneSteps || []).includes(name),
          mark: async name => { const cur = await getSt(); await saveSt({ doneSteps: [...new Set([...(cur.doneSteps || []), name])] }); },
        };
        await afterRun(steps);
      }
      // 이번 회차의 Claude Code 호출 수·비용(서버가 중간에 꺼졌다 켜졌다면 켠 뒤 분만). 다음 주와 비교해 사용량 변화를 본다.
      const line = usageText({ reused: analyzeJob().reused });
      log(`[사용량] ${line}`);
      await saveSt({ stage: 'done', usageLine: line, usageAt: Date.now() });
    } catch (e) { log(`[자동 갱신] 실패: ${e.message}`); }
    finally { running = false; }
  };
  setTimeout(tick, 5000);
  return setInterval(tick, 10 * 60 * 1000);
}

function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}
function pivotRatioCsv(csv, cfg) {
  const yes = String((cfg && cfg.yes) || 'True'), no = (cfg && cfg.no) || ['False'];
  const lines = csv.split('\n').filter(Boolean);
  if (lines.length < 2) return csv;
  const head = splitCsvLine(lines[0]);
  const groups = new Map();
  for (const ln of lines.slice(1)) {
    const c = splitCsvLine(ln), label = c[0], parts = label.split(', '), flag = parts.pop(), g = parts.slice(1).join(', ') || parts.join(', ');
    if (flag !== yes && !no.includes(flag)) continue;
    if (!groups.has(g)) groups.set(g, { y: c.slice(1).map(() => 0), d: c.slice(1).map(() => 0) });
    const e = groups.get(g);
    c.slice(1).forEach((v, i) => { const n = Number(v) || 0; e.d[i] += n; if (flag === yes) e.y[i] += n; });
  }
  if (!groups.size) return csv;
  const q = s => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const rows = [...groups.entries()].sort((a, b) => b[1].d.reduce((x, y) => x + y, 0) - a[1].d.reduce((x, y) => x + y, 0))
    .map(([g, e]) => [q(g), ...e.y.map((y, i) => (e.d[i] ? String(y / e.d[i]) : ''))].join(','));
  return [head.map(q).join(','), ...rows].join('\n');
}
