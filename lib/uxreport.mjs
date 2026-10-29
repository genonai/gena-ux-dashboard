// 종합 UX 진단 리포트.
// 지표마다 최신 저장본(단계별 인원·전환·이탈, 지표 정의, 직전 같은 길이 기간 비교)을 모아
// 분석 프레임워크(UX_FRAMEWORK, public/index.html LOGIC 블록)로 한 번에 진단하고 settings/uxReport에 저장한다.
import { runClaude } from './ai.mjs';

const groupKey = m => `${m.type}|${String(m.title || '').trim().toLowerCase()}`;
const r1 = v => Math.round(v * 10) / 10;

function parseJsonObject(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('AI 응답에서 JSON을 찾지 못했습니다.');
  return JSON.parse(text.slice(s, e + 1));
}

// 지표별 최신 저장본 + 프롬프트 재료. 직전 비교 규칙은 화면과 같다(L.comparablePrev).
export async function reportMaterials(store, L) {
  const sources = (await store.list('sources')).map(x => x.data);
  const improvements = (await store.list('improvements')).map(x => x.data).filter(x => x && x.releaseDate);
  const groups = new Map();
  for (const { id, data } of await store.list('analyses')) {
    const k = groupKey(data);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ id, ...data });
  }
  const metrics = [];
  for (const [k, arr] of groups) {
    arr.sort((a, b) => ((a.period && a.period.end) || '').localeCompare((b.period && b.period.end) || '') || (a.savedAt || 0) - (b.savedAt || 0));
    const i = arr.length - 1, m = arr[i];
    const d = await store.get('analysisData', m.id);
    if (!d || !d.csv) continue;
    const table = L.buildTable(L.parseCSV(d.csv));
    if (!table) continue;
    const it = L.INTERPRETERS[d.type || m.type](table);
    if (it.error) continue;
    if (d.measure) it.measure = d.measure;
    const src = sources.find(s => groupKey(s) === k);
    if ((src && src.hidden) || m.hidden) continue; // 겹쳐서 끈 지표는 종합 진단에서 뺀다
    const prev = L.comparablePrev(arr, i);
    metrics.push({
      title: m.title, period: m.period ? `${m.period.start}~${m.period.end}` : '',
      definition: (src && src.definition_text) || '',
      caution: L.cautionText(src && src.guide),
      grade: L.evidenceGrade(m, prev, src),
      brief: L.dataBrief(it, Number.isInteger(d.segIdx) ? d.segIdx : 0),
      comparison: prev ? L.comparisonText(m, prev, arr.filter(x => x === m || L.sameMetric(m, x))).split('\n')[0] : '',
      releases: L.releaseLines(m, prev, improvements.filter(x => x.beforeSnapId && arr.some(g => g.id === x.beforeSnapId))).join(' '),
      raw: L.rawExcerpt(table),
      platform: L.platformBrief(d.type || m.type, d.platformCsv, d.measure),
      extras: L.extraBrief(d.extraCsv),
    });
  }
  // 메인 KPI를 맨 앞에 두고, 그다음은 근거 등급 순(핵심 근거 → 참고 → 관찰만)으로 둔다.
  // 모델이 읽는 순서 자체가 근거 순이 되게 해서, 약한 근거가 위에 있다는 이유로 상위에 오르지 않게 한다.
  const order = new Map(sources.map((s, n) => [String(s.title).trim(), s.main ? -1000 + s.main : n]));
  const rank = m => (L.GRADE_RANK[m.grade && m.grade.grade] ?? 9);
  metrics.sort((a, b) => {
    const oa = order.get(a.title) ?? 1e9, ob = order.get(b.title) ?? 1e9;
    if (oa < 0 || ob < 0) return oa - ob; // 메인 KPI는 등급과 무관하게 맨 앞
    return (rank(a) - rank(b)) || (oa - ob);
  });
  return metrics;
}

const job = { running: false, error: null, startedAt: null };
export const uxReportJob = () => ({ ...job });

export async function buildUxReport(store, L, log = console.log) {
  if (job.running) return uxReportJob();
  Object.assign(job, { running: true, error: null, startedAt: Date.now() });
  try {
    const metrics = await reportMaterials(store, L);
    if (!metrics.length) throw new Error('진단할 저장본이 없습니다.');
    const team = await store.get('settings', 'team');
    const prompt = L.uxReportPrompt({ team, metrics }) + '\n\n설명이나 코드 블록 없이 JSON 객체 하나만 출력하세요.';
    const out = await runClaude(prompt, { signal: AbortSignal.timeout(15 * 60 * 1000) });
    const o = parseJsonObject(out.text);
    const str = (v, n = 600) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, n);
    const report = {
      headline: str(o.headline, 220), summary: str(o.summary, 1200),
      flows: (Array.isArray(o.flows) ? o.flows : []).slice(0, 12).map(f => ({ agent: str(f && f.agent, 60), flow: str(f && f.flow, 500), break_point: str(f && f.break_point, 200) })).filter(f => f.agent),
      candidates: L.normalizeCandidates(o.candidates),
      top5: (Array.isArray(o.top5) ? o.top5 : []).slice(0, 5).map((t, n) => ({ rank: Number(t && t.rank) || n + 1, metric: str(t && t.metric, 200), data_problem: str(t && t.data_problem, 300), user_problem: str(t && t.user_problem, 300), ux_hypothesis: str(t && t.ux_hypothesis, 300), target: str(t && t.target, 200) })),
      missing_data: (Array.isArray(o.missing_data) ? o.missing_data : []).slice(0, 8).map(x => str(x, 300)).filter(Boolean),
      caveats: (Array.isArray(o.caveats) ? o.caveats : []).slice(0, 5).map(x => str(x, 300)).filter(Boolean),
    };
    if (!report.candidates.length && !report.top5.length) throw new Error('AI 응답을 리포트 형식으로 읽지 못했습니다.');
    // 순위를 프롬프트에만 맡기지 않고 코드가 한 번 더 묶는다. 근거가 약한 항목이 1·2위에 오지 못하게 한다.
    // 지표 이름이 안 맞으면 떨어뜨리지 않고 '참고'로 본다(모델이 제목을 조금 다르게 쓰는 일이 잦다).
    const gradeByTitle = new Map(metrics.map(m => [m.title.trim().toLowerCase(), (m.grade && m.grade.grade) || 'caution_only']));
    const gradeOf = t => gradeByTitle.get(String(t.metric || '').trim().toLowerCase()) ?? 'caution_only';
    report.top5 = report.top5
      .map((t, n) => ({ t, n, r: L.GRADE_RANK[gradeOf(t)] ?? 1 }))
      .sort((a, b) => (a.r - b.r) || (a.n - b.n))
      .map(({ t }, n) => ({ ...t, rank: n + 1 }));
    report.unverified = L.unverifiedNumbers({ headline: report.headline, summary: report.summary, findings: [], candidates: report.candidates, top5: report.top5, flows: report.flows },
      metrics.flatMap(m => [m.brief, m.comparison, m.raw, m.platform, m.extras]));
    const periods = [...new Set(metrics.map(m => m.period).filter(Boolean))];
    await store.set('settings', 'uxReport', { report, period: periods.length === 1 ? periods[0] : periods.join(', '), metricCount: metrics.length, createdAt: Date.now() });
    log(`[종합 진단] 후보 ${report.candidates.length}개, TOP ${report.top5.length}`);
  } catch (e) {
    job.error = String(e && e.message || e).slice(0, 300);
    log(`[종합 진단] 실패: ${job.error}`);
  } finally { job.running = false; }
  return uxReportJob();
}
