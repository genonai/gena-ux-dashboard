// AI 해석은 이 Mac에 설치된 Claude Code(`claude -p`)를 불러서 처리한다.
// API 키 없이, Claude Code에 로그인된 계정의 요금제 한도 안에서 실행된다.
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';

const BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.CLAUDE_MODEL || 'opus';
// 생각(effort) 수준: low|medium|high|max. 비우면 Claude Code 기본값. 해석은 CLAUDE_EFFORT, 차트 가져오기(정의를 그대로 옮기는 일)는 CLAUDE_FETCH_EFFORT(기본 low).
const EFFORT = process.env.CLAUDE_EFFORT || '';
const FETCH_EFFORT = process.env.CLAUDE_FETCH_EFFORT ?? 'low';
const effortArgs = e => (/^(low|medium|high|max)$/.test(e || '') ? ['--effort', e] : []);

// Claude Code 호출 사용량 집계(프로세스가 살아 있는 동안 누적). 갱신 회차가 끝날 때 usageText()로 한 줄을 남긴다.
const usage = { fetch: {}, fetchCost: 0, analyze: {}, analyzeCost: 0, fallback: 0 };
export function usageReset() { usage.fetch = {}; usage.fetchCost = 0; usage.analyze = {}; usage.analyzeCost = 0; usage.fallback = 0; }
function track(kind, model, result) {
  if (!result || typeof result.total_cost_usd !== 'number') return;
  usage[kind][model] = (usage[kind][model] || 0) + 1;
  usage[kind + 'Cost'] += result.total_cost_usd;
}
const byModel = o => Object.entries(o).map(([m, n]) => `${m} ${n}`).join('·') || '0';
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
export function usageText(extra = {}) {
  const f = sum(usage.fetch), a = sum(usage.analyze);
  return `가져오기 ${f}회(${byModel(usage.fetch)}${usage.fallback ? `, 폴백 ${usage.fallback}` : ''}) 약 $${usage.fetchCost.toFixed(2)} · 해석 ${a}회(${byModel(usage.analyze)}${extra.reused ? `, 이어 씀 ${extra.reused}` : ''}) 약 $${usage.analyzeCost.toFixed(2)} · 합계 약 $${(usage.fetchCost + usage.analyzeCost).toFixed(2)}`;
}

export class AiError extends Error {
  constructor(code, message, text = '') { super(message); this.code = code; this.text = text; }
}

let readyCache = null;
export function aiReady() {
  if (readyCache) return readyCache;
  readyCache = new Promise(resolve => {
    execFile(BIN, ['--version'], { timeout: 10000 }, err => resolve(!err));
  });
  return readyCache;
}

// prompt를 보내고, 글이 나오는 대로 onText(지금까지 쓴 전체 글)를 부른다.
// 결과: { text, truncated }
export function runClaude(prompt, { signal, onText } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', MODEL, ...effortArgs(EFFORT), '--tools', '', '--no-session-persistence',
      // 해석은 도구가 필요 없다. 연결된 MCP 서버(특히 Amplitude)의 도구 정의가 입력에 통째로 들어가 호출마다 약 10만 토큰이 더 들어가던 것을 뺀다.
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    // 프로젝트 설정이나 CLAUDE.md가 섞이지 않도록 빈 임시 폴더에서 실행한다.
    const child = spawn(BIN, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '', buf = '', stderr = '', result = null, settled = false;
    const finish = (err, val) => { if (settled) return; settled = true; err ? reject(err) : resolve(val); };

    const onAbort = () => { child.kill('SIGTERM'); finish(new AiError('cancelled', '멈췄습니다.', text)); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }

    child.on('error', e => finish(new AiError('not_installed', `Claude Code를 실행하지 못했습니다: ${e.message}`)));
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    // 한글처럼 여러 바이트인 글자가 조각 경계에서 깨지지 않게 문자열로 이어 받는다
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta' && ev.event.delta && ev.event.delta.type === 'text_delta') {
          text += ev.event.delta.text;
          if (onText) onText(text);
        } else if (ev.type === 'result') {
          result = ev;
        }
      }
    });
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (settled) return;
      track('analyze', MODEL, result);
      if (result && !result.is_error) {
        const final = typeof result.result === 'string' && result.result ? result.result : text;
        return finish(null, { text: final, truncated: result.stop_reason === 'max_tokens' });
      }
      const msg = (result && typeof result.result === 'string' && result.result) || stderr.trim() || `Claude Code가 코드 ${code}로 끝났습니다.`;
      const lower = msg.toLowerCase();
      const codeName = /log ?in|auth|credential|api key|unauthorized/.test(lower) ? 'session_expired'
        : /rate|limit|usage|quota|overloaded/.test(lower) ? 'rate_limited'
        : /too long|context|prompt is too/.test(lower) ? 'prompt_too_large'
        : 'error';
      finish(new AiError(codeName, msg.slice(0, 500), text));
    });

    child.stdin.end(prompt);
  });
}

// Amplitude 차트 데이터를 Claude Code에 연결된 Amplitude 커넥터(MCP)로 가져온다.
// API 키나 차트 저장 없이, 저장하지 않은 차트 주소(/chart/new/…)도 그대로 실행할 수 있다.
// 모델은 도구를 한 번 부르기만 하고, 데이터는 모델이 옮겨 적은 글이 아니라 도구 응답에서 직접 읽는다.
const FETCH_MODEL = process.env.CLAUDE_FETCH_MODEL || 'haiku';
// 기간을 바꿔 실행할 때는 차트 정의를 그대로 옮겨 넣어야 해서 조금 더 꼼꼼한 모델을 쓴다.
const COPY_MODEL = process.env.CLAUDE_COPY_MODEL || 'sonnet';
const COPY_FALLBACK = process.env.CLAUDE_COPY_FALLBACK || 'sonnet';
const CHART_TOOL = process.env.AMPLITUDE_MCP_TOOL || 'mcp__amplitude__get_amplitude_charts';
const QUERY_TOOL = process.env.AMPLITUDE_MCP_QUERY_TOOL || 'mcp__amplitude__query_amplitude_data';

const csvCell = v => { const s = v == null ? '' : String(v); return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function toolJson(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('') : '';
  let j; try { j = JSON.parse(text); } catch { return null; }
  if (j && Array.isArray(j.content)) { try { j = JSON.parse(j.content.map(p => p.text || '').join('')); } catch { return null; } }
  return j && typeof j === 'object' ? j : null;
}

// 키 순서와 상관없이 같은 JSON인지
// 값이 null인 항목은 없는 것과 같게 본다(Amplitude 정의에서 null은 기본값이라는 뜻).
const canon = v => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter(k => v[k] !== null).sort().map(k => [k, canon(v[k])])) : v;
const dropNulls = v => Array.isArray(v) ? v.map(dropNulls)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)])) : v;
const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
// 도구 호출 입력은 숫자·참거짓·배열·객체가 문자열("0", "true", "[...]")로 실려 올 때가 있다.
// 기대한 값이 문자열이 아닌데 문자열로 왔으면 JSON으로 읽어 같은 값인지 본다.
function loosen(got, want) {
  if (typeof got === 'string' && typeof want !== 'string' && want !== undefined) { try { got = JSON.parse(got); } catch { return got; } }
  if (Array.isArray(got) && Array.isArray(want)) return got.map((g, i) => loosen(g, want[i]));
  if (got && typeof got === 'object' && want && typeof want === 'object' && !Array.isArray(got)) {
    return Object.fromEntries(Object.keys(got).map(k => [k, loosen(got[k], want[k])]));
  }
  return got;
}

// 세그먼테이션 차트는 CSV 대신 시계열 JSON으로 온다. 행 = 계열, 열 = 기간인 표로 바꾼다.
// 계열 이름이 잘려 오면(seriesNames가 계열 수보다 짧으면) seriesMetadata로 이름을 만든다.
// 계열 이름이 아예 없으면(기간을 바꿔 다시 계산한 결과) 차트 정의의 이벤트로 "이벤트 (필터값)" 이름을 만든다.
const eventLabel = ev => {
  const vals = (ev.filters || []).flatMap(f => f.subprop_value || []);
  return `${ev.event_type}${vals.length ? ` (${vals.join(', ')})` : ''}`;
};
// labels: { 원래 이름 일부: 바꿀 이름 } (예: { 'TOTALS(B)/TOTALS(A)': '완료율' }). 수식 차트를 읽기 쉽게 한다.
const relabel = (name, labels) => { let n = String(name); for (const [k, v] of Object.entries(labels || {})) if (k && n.includes(k)) n = n.split(k).join(v); return n.replace(/^Formula [A-Z]:\s*/, ''); };
function seriesRows(data, def, labels, overall) {
  let j = data && data.jsonResponse;
  // 이벤트를 여러 개 겹친 히스토그램은 timeSeries 대신 series·xValues·seriesMeta 이름으로 온다
  if (j && !Array.isArray(j.timeSeries) && Array.isArray(j.series) && Array.isArray(j.xValues)) j = { ...j, timeSeries: j.series, xValuesForTimeSeries: j.xValues, seriesMetadata: j.seriesMeta || j.seriesMetadata };
  if (!j || !Array.isArray(j.timeSeries)) return null;
  const names = Array.isArray(data.seriesNames) ? data.seriesNames : [];
  const meta = Array.isArray(j.seriesMetadata) ? j.seriesMetadata : [];
  const events = def && def.params && Array.isArray(def.params.events) ? def.params.events : [];
  const xs = (j.xValuesForTimeSeries || []).map(x => String(x).slice(0, 10));
  // 세그먼트가 여럿(예: 전체·Android·iOS·PC)인 차트는 계열 이름 끝에 "; 세그먼트 이름"을 붙인다
  const segs = def && def.params && Array.isArray(def.params.segments) ? def.params.segments : [];
  const label = i => {
    const m = meta[i] || {};
    const segName = segs.length > 1 && Number.isInteger(m.segmentIndex) && segs[m.segmentIndex] ? (segs[m.segmentIndex].name || `세그먼트 ${m.segmentIndex + 1}`) : '';
    const ev = Number.isInteger(m.eventIndex) && events[m.eventIndex] ? eventLabel(events[m.eventIndex]) : '';
    // 세그먼트가 하나인 차트는 예전과 똑같이 이름을 만든다(등록된 지표의 계열 이름이 바뀌지 않게)
    if (!segName) return names[i] || [m.formula || ev, m.segment].filter(Boolean).join(', ') || `계열 ${i + 1}`;
    // 세그먼트가 여럿이면 seriesNames(세그먼트 수만큼만 오는 경우가 있음) 대신 메타데이터로 만든다
    const gb = Array.isArray(m.eventGroupBys) && m.eventGroupBys.length ? m.eventGroupBys.join(', ') : '';
    return `${[m.formula || ev, gb, m.segment].filter(Boolean).join(', ') || `계열 ${i + 1}`}; ${segName}`;
  };
  const base = j.timeSeries.map((_, i) => label(i));
  // 그룹으로 나눈 차트(예: 오류 유형별)에서 이름이 겹치면 그룹 값을 붙여 구분한다(겹치지 않는 차트는 그대로)
  const dup = n => base.filter(x => x === n).length > 1;
  const named = base.map((n, i) => { const gb = (meta[i] && Array.isArray(meta[i].eventGroupBys)) ? meta[i].eventGroupBys.join(', ') : ''; return dup(n) && gb && !n.includes(gb) ? (n.includes('; ') ? n.replace('; ', `, ${gb}; `) : `${n}, ${gb}`) : n; });
  // overall: 기간 전체를 한 덩어리로 읽는다. Amplitude 응답의 overallSeries는 선택한 날짜 범위 전체의 값이다
  // (사람 수는 기간 안에서 중복을 뺀 값, 건수는 합, 비율·백분위수는 전체 기준). 주·월 단위 묶음에 기간이 끌려가지 않아
  // 수~화 같은 임의의 7일도 정확히 받는다.
  if (overall && Array.isArray(j.overallSeries) && j.overallSeries.length === j.timeSeries.length && j.overallSeries.every(x => Array.isArray(x) && x.length)) { // 히스토그램처럼 기간 전체 값이 없는 차트는 아래 구간별 표로 읽는다
    return [['Series', xs[0] || 'total'], ...j.overallSeries.map((s, i) => [relabel(named[i], labels), s && s[0] && s[0].value != null ? s[0].value : ''])];
  }
  return [['Series', ...xs], ...j.timeSeries.map((s, i) => [relabel(named[i], labels), ...(s || []).map(p => (p && p.value != null ? p.value : ''))])];
}

function csvFromData(data, noData, def, labels, overall) {
  if (noData || (data && data.noData)) throw new AiError('no_data', '이 기간에 해당하는 사용자가 없어 데이터가 비어 있습니다. 다음 갱신 때 다시 확인합니다.');
  // 퍼널의 "전환 시간" 차트(CONVERSION_TIME_DISTRIBUTION)는 표가 아니라 구간 분포로 온다. 중앙값·평균(ms)만 두 줄로 뽑는다.
  const tt = def && def.params && def.params.metric === 'CONVERSION_TIME_DISTRIBUTION' && data && data.jsonResponse && Array.isArray(data.jsonResponse.data) ? data.jsonResponse.data[0] : null;
  if (tt && Array.isArray(tt.medianTransTimes)) {
    const last = a => (Array.isArray(a) && a.length ? a[a.length - 1] : -1);
    const med = last(tt.medianTransTimes), avg = last(tt.avgTransTimes);
    if (!(med >= 0)) throw new AiError('no_data', '이 기간에 해당하는 사용자가 없어 데이터가 비어 있습니다. 다음 갱신 때 다시 확인합니다.');
    return ['Series,Value', `중앙값(ms),${med}`, `평균(ms),${avg >= 0 ? avg : ''}`].join('\n');
  }
  const rows = (data && data.csvResponse && data.csvResponse.data) || seriesRows(data, def, labels, overall);
  if (!Array.isArray(rows)) throw new AiError('error', '이 종류의 차트는 표 데이터로 받을 수 없습니다.');
  // 머리글만 있고 값 행이 없으면(사용자 0명) 빈 데이터로 본다.
  if (rows.filter(r => Array.isArray(r) && r.some(c => c !== '' && c != null)).length < 2) throw new AiError('no_data', '이 기간에 해당하는 사용자가 없어 데이터가 비어 있습니다. 다음 갱신 때 다시 확인합니다.');
  return rows.map(row => (Array.isArray(row) ? row : []).map(csvCell).join(',')).join('\n');
}

// Claude Code로 도구 하나를 정해진 입력으로 한 번 부르고, 그 도구의 응답 JSON을 돌려준다.
// 모델이 입력을 바꿔 부르면(정의를 잘못 옮기면) 결과를 쓰지 않는다.
function callTool(tool, input, { signal, model = FETCH_MODEL } = {}) {
  const prompt = `Call ${tool} exactly once with exactly this JSON input, copied verbatim without changing, adding or removing anything:\n${JSON.stringify(input)}\nDo not call any other tool except the tool search needed to load it. Then reply only: DONE`;
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, ...effortArgs(FETCH_EFFORT),
      '--allowedTools', tool, '--no-session-persistence'];
    // 그룹이 많은 차트(예: 연령대 × 에이전트)는 응답이 Claude Code 기본 한도(25,000 토큰)를 넘어 못 받았다. 가져오는 호출에만 한도를 올린다.
    const child = spawn(BIN, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MAX_MCP_OUTPUT_TOKENS: process.env.FETCH_MAX_MCP_OUTPUT_TOKENS || '100000' } });
    let buf = '', stderr = '', found = null, toolError = null, result = null, settled = false, mismatch = false;
    const toolIds = new Set();
    const finish = (err, val) => { if (settled) return; settled = true; err ? reject(err) : resolve(val); };

    const onAbort = () => { child.kill('SIGTERM'); finish(new AiError('cancelled', 'Amplitude 데이터를 가져오는 시간이 너무 오래 걸려 멈췄습니다.')); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }

    child.on('error', e => finish(new AiError('not_installed', `Claude Code를 실행하지 못했습니다: ${e.message}`)));
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    // 한글처럼 여러 바이트인 글자가 조각 경계에서 깨지지 않게 문자열로 이어 받는다
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
        if (ev.type === 'assistant') {
          for (const c of content) {
            if (c.type !== 'tool_use' || c.name !== tool) continue;
            // 모델이 넣은 입력이 우리가 준 입력과 같을 때만 그 결과를 믿는다.
            const got = loosen(Object.assign({}, c.input), input);
            delete got.rationale;
            if (sameJson(got, input)) toolIds.add(c.id); else mismatch = true;
          }
        } else if (ev.type === 'user') {
          for (const c of content) {
            if (c.type !== 'tool_result' || !toolIds.has(c.tool_use_id) || found) continue;
            let j = toolJson(c.content);
            // 응답이 너무 커서 Claude Code가 파일로 돌린 경우("Output has been saved to <경로>"): 그 파일을 읽어 쓴다.
            if (!j) {
              const raw = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map(p => (p && p.text) || '').join('') : '';
              const m = /(?:saved to|saved in)[:\s]+(\/[^\s\n"]+?\.(?:txt|json))/.exec(raw);
              if (m) { try { j = toolJson(fs.readFileSync(m[1], 'utf8')); } catch { /* 읽지 못하면 아래 오류로 */ } }
            }
            if (!j) { toolError = String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 300); continue; }
            found = j;
          }
        } else if (ev.type === 'result') {
          result = ev;
        }
      }
    });
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (settled) return;
      track('fetch', model, result);
      if (found) return finish(null, found);
      const msg = toolError || (result && typeof result.result === 'string' && result.result) || stderr.trim() || `Claude Code가 코드 ${code}로 끝났습니다.`;
      const lower = msg.toLowerCase();
      // 결과가 너무 크면 Claude Code가 파일로 돌리며 경로(…mcp…)를 남겨 로그인 오류로 잘못 읽히던 문제
      if (/exceeds maximum allowed tokens/.test(lower)) {
        return finish(new AiError('too_large', 'Amplitude 결과가 너무 커서 받지 못했습니다. 집계 단위를 주 단위로 바꾸거나 그룹(나눠 보기) 수를 줄여 주세요.'));
      }
      if (/sign in|re-?authenticate|re-?authoriz|token expired|needs-auth|\/mcp\b/.test(lower)) {
        // 원문 일부를 붙여 둔다: 로그인 문제가 아닌 다른 오류가 이 문구에 가려지지 않게
        return finish(new AiError('session_expired', `Claude Code의 Amplitude 커넥터 로그인이 필요합니다. 터미널에서 claude를 실행해 /mcp로 amplitude에 로그인하세요. (원문: ${msg.replace(/\s+/g, ' ').slice(0, 160)})`));
      }
      if (mismatch) return finish(new AiError('error', '차트 정의를 정확히 옮기지 못해 결과를 버렸습니다. 다시 갱신해 주세요.'));
      if (!toolIds.size) return finish(new AiError('no_tool', `Claude Code에서 Amplitude 커넥터(${tool})를 쓰지 못했습니다. claude를 실행해 /mcp에서 amplitude가 연결돼 있는지 확인하세요.`));
      finish(new AiError('error', msg.slice(0, 500)));
    });

    child.stdin.end(prompt);
  });
}

const rangeOf = days => `Last ${days} Days`;

// 'YYYY-MM-DD'를 Amplitude 정의의 start/end(유닉스 초)로. Amplitude는 이 값을 UTC 날짜로 읽은 뒤
// 차트 timezone의 그 날짜로 자르므로, 원하는 날짜의 UTC 0시(끝은 23:59:59)를 보낸다.
// (확인: KST 0시를 보내면 하루 앞 날짜부터 계산된다.)
function daySeconds(day, endOfDay) {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0) / 1000);
}

// ref: { editId } 또는 { chartId }
// opts.days: 데이터 기간(일). opts.range: { start, end } 직접 정한 날짜(있으면 days보다 우선).
// 차트에 저장된 기간과 다르면 정의의 기간만 바꿔 다시 계산한다.
// opts.definition: 전에 받아 둔 차트 정의(있으면 정의를 다시 받지 않는다). 저장하지 않은 차트는 정의가 바뀌지 않는다.
// 결과: { csv, definition }
export async function fetchChartViaClaude(ref, { signal, days, range, definition, seriesLabels, patchDefinition, includeIncomplete, overall } = {}) {
  const want = range ? null : days ? rangeOf(days) : null;
  const asIs = p => !range && (!want || (p && p.range === want && !p.start));
  let def = definition || null;
  if (!def || asIs(def.params)) {
    const key = ref.editId ? 'chartEditIds' : 'chartIds';
    // 날짜 범위를 받아 어차피 아래에서 다시 계산할 때는 정의만 쓰므로, 그룹 수를 1로 줄여 응답을 작게 받는다(큰 차트의 크기 한도 초과 방지)
    const j = await callTool(CHART_TOOL, { [key]: [ref.editId || ref.chartId], include: 'data', timeSeriesLimit: 0, excludeIncompleteDatapoints: !includeIncomplete, ...(range ? { groupByLimit: 1 } : {}) }, { signal });
    const r = Array.isArray(j.results) ? j.results[0] : null;
    if (!r || !r.success) throw new AiError('error', `Amplitude가 차트를 실행하지 못했습니다: ${String((r && (r.error || r.message)) || j.error || '알 수 없는 오류').slice(0, 300)}`);
    def = r.definition || def;
    if (!def || !def.params || asIs(def.params)) return { csv: csvFromData(r.data, r.noData, def, seriesLabels, overall), definition: def };
  }
  // 지표 설정으로 정의를 고쳐야 하면(예: 자동 재개 전송 제외) 여기서 덧붙인다. 보관되는 정의도 고친 것이 된다.
  if (typeof patchDefinition === 'function') def = patchDefinition(def);
  // 기간만 바꾼 정의로 다시 계산한다.
  const params = Object.assign({}, def.params);
  delete params.range; delete params.start; delete params.end;
  if (range) { params.start = daySeconds(range.start, false); params.end = daySeconds(range.end, true); }
  else params.range = want;
  // null 항목은 빼서 보낸다(옮겨 적을 양이 줄고, 뜻은 같다).
  const qdef = { app: String(def.app), type: def.type, params: dropNulls(params) };
  if (def.version != null) qdef.version = def.version;
  if (def.vis) qdef.vis = def.vis;
  const query = { projectId: String(def.app), definition: qdef, timeSeriesLimit: 0, excludeIncompleteDatapoints: !includeIncomplete };
  // COPY_MODEL(예: haiku)이 정의를 정확히 옮기지 못해 버려지면 COPY_FALLBACK(기본 sonnet)으로 한 번만 다시 한다.
  let q;
  try { q = await callTool(QUERY_TOOL, query, { signal, model: COPY_MODEL }); }
  catch (e) {
    if (COPY_FALLBACK && COPY_FALLBACK !== COPY_MODEL && /정확히 옮기지/.test(String(e && e.message))) {
      usage.fallback++;
      console.log(`[가져오기] ${COPY_MODEL}이 차트 정의를 틀리게 옮겨 ${COPY_FALLBACK}으로 다시 합니다.`);
      q = await callTool(QUERY_TOOL, query, { signal, model: COPY_FALLBACK });
    }
    else throw e;
  }
  // 세그먼테이션은 차트 그림을 못 만들어도 success:false와 함께 데이터를 보낸다. 데이터가 있으면 쓴다.
  if (q.success === false && !(q.data && (q.data.csvResponse || q.data.jsonResponse))) throw new AiError('error', `Amplitude가 차트를 계산하지 못했습니다: ${String(q.error || '알 수 없는 오류').slice(0, 300)}`);
  return { csv: csvFromData(q.data, q.noData, def, seriesLabels, overall), definition: def };
}
