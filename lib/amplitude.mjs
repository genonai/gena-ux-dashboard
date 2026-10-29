// 차트 데이터를 가져오는 길은 둘이다.
// 1) .env에 API 키가 있으면 Amplitude Dashboard REST API로 저장된 차트를 가져온다.
//    문서: https://amplitude.com/docs/apis/analytics/dashboard-rest  (GET /api/3/chart/:chart_id/csv, Basic 인증)
// 2) 키가 없거나 저장하지 않은 차트(/chart/new/…)면 Claude Code의 Amplitude 커넥터로 가져온다.
import { aiReady, fetchChartViaClaude } from './ai.mjs';

export function amplitudeReady() {
  return !!(process.env.AMPLITUDE_API_KEY && process.env.AMPLITUDE_SECRET_KEY);
}

// 자동 갱신을 돌릴 수 있는지: API 키가 있거나 Claude Code가 설치돼 있으면 된다.
export async function fetchReady() {
  return amplitudeReady() || (await aiReady());
}

export function chartIdOf(chart) {
  const s = String(chart || '').trim();
  const m = s.match(/\/chart\/([A-Za-z0-9]+)/);
  if (m) return m[1] === 'new' ? null : m[1]; // 저장하지 않은 차트는 editIdOf로 다룬다
  return /^[A-Za-z0-9_-]{4,40}$/.test(s) ? s : null;
}

// 저장하지 않은 차트 주소(…/chart/new/<editId>)의 editId
export function editIdOf(chart) {
  const m = String(chart || '').match(/\/chart\/new\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function baseUrl(chart) {
  if (/eu\.amplitude\.com/i.test(String(chart)) || String(process.env.AMPLITUDE_REGION || '').toLowerCase() === 'eu') {
    return 'https://analytics.eu.amplitude.com';
  }
  return 'https://amplitude.com';
}

// 응답이 CSV 그대로인지 JSON으로 감싼 CSV인지 문서에 나와 있지 않아서 둘 다 받는다.
export function extractCsv(body) {
  const t = String(body || '').replace(/^﻿/, '').trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    let j;
    try { j = JSON.parse(t); } catch { return t; }
    if (typeof j === 'string') return j;
    for (const k of ['data', 'csv', 'result']) if (j && typeof j[k] === 'string') return j[k];
    const keys = j && typeof j === 'object' ? Object.keys(j).slice(0, 8).join(', ') : typeof j;
    throw new Error(`Amplitude 응답에서 CSV를 찾지 못했습니다 (응답 항목: ${keys}).`);
  }
  return t;
}

// 결과: { csv, definition }. definition은 커넥터로 받았을 때만 있고, 다음 갱신 때 opts.definition으로 다시 넘긴다.
// opts.days(최근 N일)나 opts.range({ start, end })를 주면 그 기간으로 계산한다(커넥터로만 가능. REST API는 차트에 저장된 기간 그대로).
// 시작 단계(첫 단계)의 agent_run·prompt_submit 이벤트에 `input_source ≠ resume` 필터를 덧붙인다.
// resume = 로그인 직후 서비스가 대신 이어 보낸 요청(사용자가 직접 실행한 게 아님). 이미 input_source 필터가 있으면 건드리지 않는다.
// 이 값은 10/3부터 안정적으로 붙는다. 그 전 데이터에는 구분 표시가 없어 그대로 포함된다.
export function excludeResume(def) {
  if (!def || !def.params || !Array.isArray(def.params.events) || !def.params.events.length) return def;
  const out = JSON.parse(JSON.stringify(def));
  const F = { group_type: { name: 'User', is_computed: false }, subprop_op: 'is not', subprop_key: 'input_source', subprop_type: 'event', subprop_value: ['resume'] };
  const leaf = e => {
    if (!e || typeof e !== 'object') return;
    if (Array.isArray(e.events) && e.events.length) { e.events.forEach(leaf); return; }
    if (e.event_type === 'agent_run' || e.event_type === 'prompt_submit') {
      if (!(e.filters || []).some(f => f.subprop_key === 'input_source')) e.filters = [...(e.filters || []), { ...F }];
    }
  };
  leaf(out.params.events[0]);
  return out;
}

export async function fetchChartCsv(chart, { signal, days, range, definition, seriesLabels, patchDefinition, includeIncomplete, overall } = {}) {
  const editId = editIdOf(chart);
  if (editId) return fetchChartViaClaude({ editId }, { signal, days, range, definition, seriesLabels, patchDefinition, includeIncomplete, overall });
  const id = chartIdOf(chart);
  if (!id) throw new Error('차트 주소에서 차트 ID를 찾지 못했습니다. Amplitude 차트 주소를 확인하세요.');
  // 저장된 차트는 정의가 바뀔 수 있어서, 부르는 쪽이 최근에 받은 정의일 때만 definition으로 넘긴다(자동 갱신은 DEF_TTL_DAYS 안에서만).
  if (!amplitudeReady() || days || range) return fetchChartViaClaude({ chartId: id }, { signal, days, range, definition, seriesLabels, patchDefinition, includeIncomplete, overall });
  const auth = Buffer.from(`${process.env.AMPLITUDE_API_KEY}:${process.env.AMPLITUDE_SECRET_KEY}`).toString('base64');
  const res = await fetch(`${baseUrl(chart)}/api/3/chart/${encodeURIComponent(id)}/csv`, {
    headers: { Authorization: `Basic ${auth}` }, signal,
  });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Amplitude 인증에 실패했습니다. API 키와 시크릿 키, 지역(US/EU)을 확인하세요.');
    if (res.status === 404) throw new Error('Amplitude에서 이 차트를 찾지 못했습니다. 차트 주소를 확인하세요.');
    if (res.status === 429) throw new Error('Amplitude 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.');
    throw new Error(`Amplitude가 오류 ${res.status}로 응답했습니다.`);
  }
  return { csv: extractCsv(body), definition: null };
}
