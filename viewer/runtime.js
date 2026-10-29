// 보기 전용 클라우드 사본용 runtime. 로컬 서버 대신, 함께 올린 data/*.json(올린 시점의 스냅샷)을 읽는다.
// 쓰기는 모두 막고(보기 권한), AI 해석·링크 불러오기 같은 로컬 서버 기능은 없다.
(function () {
  'use strict';
  const err = (code, extra) => Object.assign(new Error(code), { code }, extra || {});
  const cache = new Map();
  async function load(c) {
    if (!cache.has(c)) {
      cache.set(c, fetch(`/data/${c}.json`, { cache: 'no-store' }).then(async r => {
        if (r.status === 401) { location.reload(); throw err('unavailable'); }
        if (!r.ok) return {};
        return r.json();
      }).catch(e => { cache.delete(c); throw e; }));
    }
    return cache.get(c);
  }
  const denied = () => Promise.reject(err('invalid_argument', { message: '보기 전용 사본에서는 바꿀 수 없습니다.' }));

  function docRef(c, id) {
    const get = async () => {
      const obj = await load(c);
      return Object.hasOwn(obj, id) ? { id, exists: true, data: () => obj[id] } : { id, exists: false, data: () => undefined };
    };
    return { id, set: denied, update: denied, delete: denied, get, onSnapshot(cb, onErr) { get().then(cb, e => onErr && onErr(e)); return () => {}; } };
  }
  function query(c, order, lim) {
    return {
      orderBy: (f, dir) => query(c, { f, dir }, lim),
      limit: n => query(c, order, n),
      doc: id => docRef(c, id || 'new'),
      onSnapshot(cb, onErr) {
        load(c).then(obj => {
          let docs = Object.entries(obj).map(([id, data]) => ({ id, data }));
          if (order) {
            const s = order.dir === 'desc' ? -1 : 1;
            docs.sort((a, b) => ((a.data[order.f] ?? 0) > (b.data[order.f] ?? 0) ? 1 : (a.data[order.f] ?? 0) < (b.data[order.f] ?? 0) ? -1 : 0) * s);
          }
          if (lim) docs = docs.slice(0, lim);
          cb({ docs: docs.map(d => ({ id: d.id, data: () => d.data })) });
        }, e => onErr && onErr(e));
        return () => {};
      },
    };
  }
  const db = { collection: c => query(c), doc: p => { const [c, id] = String(p).split('/'); return docRef(c, id); } };

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
  };
  const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#0C5A61"/></svg>');
  const user = {
    id: async () => 'viewer',
    can: async () => false,
    isOwner: async () => false,
    profiles: async ids => Object.fromEntries(ids.map(i => [i, { id: i, name: '팀', avatarUrl: avatar }])),
    search: async () => [],
  };

  // 페이지가 '보기 전용 사본'임을 알 수 있게 올린 시각을 알려 준다
  window.viewerInfo = { publishedAt: null };
  load('_meta').then(m => { window.viewerInfo.publishedAt = m && m.publishedAt || null; document.dispatchEvent(new Event('viewer-meta')); }).catch(() => {});

  window.claude = {
    async use(name) {
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'downloads') return downloads;
      return null; // sample(AI) 없음
    },
  };
})();
