// claude.ai의 window.claude 자리를 로컬 서버로 대신한다.
// 페이지는 db / sample / downloads / user 네 가지를 같은 방식으로 쓰고, 실제 일은 server.mjs가 한다.
(function () {
  'use strict';
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'amp' };
  const err = (code, extra) => Object.assign(new Error(code), { code }, extra || {});

  async function api(method, url, body) {
    let res;
    try { res = await fetch(url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw err('unavailable'); }
    // 로그인이 풀렸으면(비밀번호 변경 등) 새로 고쳐 로그인 화면으로 보낸다.
    if (res.status === 401) { location.reload(); throw err('unavailable'); }
    if (res.status === 404) throw err('not_found');
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw err(j.code || (res.status >= 500 ? 'unavailable' : 'invalid_argument'), { message: j.message }); }
    return res.json();
  }
  const newId = () => {
    const a = new Uint8Array(15); crypto.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 20);
  };

  /* ----- 실시간 반영: 서버가 바뀐 컬렉션 이름을 알려 주면 다시 읽는다 ----- */
  const subs = new Map();
  const subscribe = (c, fn) => { if (!subs.has(c)) subs.set(c, new Set()); subs.get(c).add(fn); return () => subs.get(c).delete(fn); };
  const refreshAll = () => subs.forEach(set => set.forEach(fn => fn()));
  const es = new EventSource('/api/events');
  es.addEventListener('change', e => { try { const { c } = JSON.parse(e.data); (subs.get(c) || []).forEach(fn => fn()); } catch (x) { /* ignore */ } });
  // 서버가 다시 켜지면 전부 새로 읽는다
  es.addEventListener('open', refreshAll);
  // 일부 터널(Cloudflare 빠른 터널 등)은 실시간 스트림을 넘기지 못한다.
  // 서버의 hello가 5초 안에 안 오면 10초마다 전부 다시 읽는 방식으로 바꾼다.
  let live = false, poll = null;
  es.addEventListener('hello', () => { live = true; if (poll) { clearInterval(poll); poll = null; } });
  setTimeout(() => { if (!live && !poll) poll = setInterval(() => { if (!document.hidden) refreshAll(); }, 10000); }, 5000);

  function docRef(c, id) {
    const url = `/api/db/${c}/${encodeURIComponent(id)}`;
    const get = async () => {
      const r = await api('GET', url);
      return r.exists ? { id, exists: true, data: () => r.data } : { id, exists: false, data: () => undefined };
    };
    return {
      id,
      set: data => api('PUT', url, data),
      update: data => api('PATCH', url, data),
      delete: () => api('DELETE', url),
      get,
      onSnapshot(cb, onErr) {
        const run = () => get().then(cb, e => onErr && onErr(e));
        run();
        return subscribe(c, run);
      },
    };
  }
  function query(c, order, lim) {
    return {
      orderBy: (f, dir) => query(c, { f, dir }, lim),
      limit: n => query(c, order, n),
      doc: id => docRef(c, id || newId()),
      onSnapshot(cb, onErr) {
        const run = async () => {
          try {
            let docs = await api('GET', `/api/db/${c}`);
            if (order) {
              const s = order.dir === 'desc' ? -1 : 1;
              docs.sort((a, b) => ((a.data[order.f] ?? 0) > (b.data[order.f] ?? 0) ? 1 : (a.data[order.f] ?? 0) < (b.data[order.f] ?? 0) ? -1 : 0) * s);
            }
            if (lim) docs = docs.slice(0, lim);
            cb({ docs: docs.map(d => ({ id: d.id, data: () => d.data })) });
          } catch (e) { if (onErr) onErr(e); }
        };
        run();
        return subscribe(c, run);
      },
    };
  }
  const db = { collection: c => query(c), doc: p => { const [c, id] = String(p).split('/'); return docRef(c, id); } };

  /* ----- AI: 서버가 Claude Code로 실행하고 글을 흘려보낸다 ----- */
  async function sample(prompt, opts) {
    opts = opts || {};
    let res;
    try { res = await fetch('/api/ai', { method: 'POST', headers: H, body: JSON.stringify({ prompt }), signal: opts.signal }); }
    catch (e) { throw err(e && e.name === 'AbortError' ? 'cancelled' : 'unavailable'); }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw err(j.code || 'error'); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.d) { text += m.d; if (opts.onText) opts.onText({ text }); }
          else if (m.done) return { text: m.text || text, truncated: !!m.truncated };
          else if (m.error) throw err(m.error, { text: m.text || text, message: m.message });
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw err('cancelled', { text });
      throw e;
    }
    throw err('error', { text });
  }
  sample.json = async (prompt, opts) => {
    const { text } = await sample(prompt + '\n\n설명이나 코드 블록 없이 JSON 객체 하나만 출력하세요.', opts);
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s < 0 || e <= s) throw err(text.trim() ? 'invalid_json' : 'empty_completion');
    try { return JSON.parse(text.slice(s, e + 1)); } catch (x) { throw err('invalid_json'); }
  };

  /* ----- 파일 내려받기 ----- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
  };

  /* ----- 사용자: 이 Mac의 한 사람 ----- */
  const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#0C5A61"/><text x="12" y="16" text-anchor="middle" font-size="11" fill="#fff" font-family="sans-serif">나</text></svg>');
  const me = { id: 'local', name: '나', avatarUrl: avatar };
  const user = {
    id: async () => me.id,
    can: async () => true,
    isOwner: async () => true,
    profiles: async ids => Object.fromEntries(ids.map(i => [i, i === me.id ? me : { id: i, name: '알 수 없음', avatarUrl: avatar }])),
    search: async () => [me],
  };

  const statusP = fetch('/api/status').then(r => r.json()).catch(() => ({ ai: false, amplitude: false }));
  window.localApi = {
    status: () => statusP,
    runSource: id => api('POST', `/api/sources/${encodeURIComponent(id)}/run`),
    runAll: () => api('POST', '/api/sources/run-all'),
    refreshStatus: () => api('GET', '/api/refresh-status'),
    analyzeAll: () => api('POST', '/api/analyze-all'),
    analyzeStatus: () => api('GET', '/api/analyze-all'),
    fetchChart: body => api('POST', '/api/fetch-chart', body),
    uxReport: () => api('POST', '/api/ux-report'),
    uxReportStatus: () => api('GET', '/api/ux-report'),
  };
  window.claude = {
    async use(name) {
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'downloads') return downloads;
      if (name === 'sample') return (await statusP).ai ? sample : null;
      return null;
    },
  };
})();
