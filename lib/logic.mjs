// 페이지(public/index.html)의 LOGIC 블록을 그대로 실행해, 서버에서 만든 저장본이
// 화면에서 계산한 값과 정확히 같아지게 한다.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export function loadLogic(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  const m = html.match(/\/\* ===== LOGIC START ===== \*\/([\s\S]*?)\/\* ===== LOGIC END ===== \*\//);
  if (!m) throw new Error('LOGIC 블록을 찾지 못했습니다: ' + htmlPath);
  // eslint-disable-next-line no-new-func
  return new Function(`'use strict';${m[1]}\nreturn { TYPES, OVERALL_ROW, parseCSV, buildTable, INTERPRETERS, snapshotSummary, tableToCSV, clean, analysisPrompt, normalizeAnalysis, comparisonText, unverifiedNumbers, comparablePrev, sameMetric, dataBrief, rawExcerpt, uxReportPrompt, normalizeCandidates, platformBrief, platformRows, extraBrief, cautionText, evidenceGrade, GRADE_RANK, releaseLines };`)();
}

export const newId = () => randomBytes(15).toString('base64url').slice(0, 20);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// job: { title, type, csv, period: { start, end }, sourceId?, segIdx?, note? }
export function buildWrites(L, job, now = Date.now()) {
  if (!L.TYPES[job.type]) throw new Error(`데이터 종류는 ${Object.keys(L.TYPES).join(', ')} 중 하나여야 합니다.`);
  if (!String(job.title || '').trim()) throw new Error('이름이 필요합니다.');
  const p = job.period || {};
  if (!ISO.test(p.start || '') || !ISO.test(p.end || '')) throw new Error('기간은 YYYY-MM-DD 형식이어야 합니다.');
  const table = L.buildTable(L.parseCSV(job.csv));
  if (!table) throw new Error('받은 데이터에서 표를 찾지 못했습니다.');
  const interp = L.INTERPRETERS[job.type](table);
  if (interp.error) throw new Error('해석 실패: ' + interp.error);
  if (job.cardSingle) interp.cardSingle = true; // 카드 둘째 칸에 가장 약한 단계 대신 사람 수를 보인다
  if (job.measure) interp.measure = job.measure; // 값 지표(소요 시간 등): 합계가 아니라 값으로 읽는다
  if (job.pin) interp.pin = job.pin; // 대표 줄 고정(주마다 1등 줄이 바뀌어도 같은 줄로 비교)
  let segIdx = Number.isInteger(job.segIdx) ? job.segIdx : 0;
  if (interp.kind === 'funnel' && !Number.isInteger(job.segIdx)) {
    const i = interp.segments.findIndex(s => L.OVERALL_ROW.test(s.label));
    segIdx = i >= 0 ? i : 0;
  }
  if (interp.kind === 'funnel' && job.pin) { const i = interp.segments.findIndex(x => String(x.label).includes(job.pin)); if (i >= 0) segIdx = i; }
  const summary = L.snapshotSummary(interp, segIdx);
  const { csv, rows, truncated } = L.tableToCSV(table);
  const id = newId();
  const fileName = `Amplitude ${p.start} ~ ${p.end}`;
  return {
    id, summary,
    writes: [
      { collection: 'analysisData', id, data: L.clean({ csv, type: job.type, measure: job.measure || null, segIdx, fileName, context: { service: '', goal: '' }, analysis: null, analysisAt: null, truncated }) },
      { collection: 'analyses', id, data: L.clean({
        title: job.title.trim(), note: job.note || '', type: job.type, fileName, rows, totalRows: table.body.length,
        savedBy: null, savedAt: now, updatedAt: now, summary, headline: null, hasAnalysis: false,
        source: 'amplitude', period: { start: p.start, end: p.end }, sourceId: job.sourceId || null,
      }) },
    ],
  };
}
