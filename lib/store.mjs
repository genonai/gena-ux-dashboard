// data/<컬렉션>.json 에 { id: 문서 } 형태로 저장하는 작은 문서 저장소.
// 쓰기는 한 줄로 세워 처리하고, 임시 파일에 쓴 뒤 바꿔치기해서 중간에 꺼져도 파일이 깨지지 않게 한다.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = new Set(['analyses', 'analysisData', 'improvements', 'sources', 'settings']);
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class NotFound extends Error {}

export function createStore(dir) {
  const cache = new Map();
  const listeners = new Set();
  let queue = Promise.resolve();

  // 컬렉션마다 마지막으로 읽거나 쓴 파일 수정 시각. 다른 프로세스(별도 스크립트 등)가 파일을 바꿨는지 알아본다.
  const mtimes = new Map();
  const fileOf = c => path.join(dir, `${c}.json`);
  const mtimeOf = async c => { try { return (await fs.stat(fileOf(c))).mtimeMs; } catch { return 0; } };

  async function load(c) {
    if (cache.has(c)) {
      // 파일이 다른 프로세스에서 바뀌었으면 캐시를 버리고 다시 읽는다(그대로 두면 다음 저장 때 그 내용을 덮어쓴다)
      if (await mtimeOf(c) === mtimes.get(c)) return cache.get(c);
      cache.delete(c);
    }
    let obj = {};
    try { obj = JSON.parse(await fs.readFile(fileOf(c), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    cache.set(c, obj);
    mtimes.set(c, await mtimeOf(c));
    return obj;
  }
  async function persist(c) {
    await fs.mkdir(dir, { recursive: true });
    const file = fileOf(c), tmp = `${file}.${process.pid}.tmp`; // 프로세스마다 임시 파일을 따로 쓴다
    await fs.writeFile(tmp, JSON.stringify(cache.get(c)));
    await fs.rename(tmp, file);
    mtimes.set(c, await mtimeOf(c));
  }
  function write(c, fn) {
    const run = queue.then(async () => {
      const obj = await load(c);
      fn(obj);
      await persist(c);
      listeners.forEach(l => { try { l(c); } catch (e) { /* listener errors don't block writes */ } });
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    async list(c) { const obj = await load(c); return Object.entries(obj).map(([id, data]) => ({ id, data })); },
    async get(c, id) { const obj = await load(c); return Object.hasOwn(obj, id) ? obj[id] : null; },
    set(c, id, data) { return write(c, obj => { obj[id] = data; }); },
    update(c, id, patch) {
      return write(c, obj => {
        if (!Object.hasOwn(obj, id)) throw new NotFound(`${c}/${id}`);
        obj[id] = Object.assign({}, obj[id], patch);
      });
    },
    remove(c, id) { return write(c, obj => { delete obj[id]; }); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
