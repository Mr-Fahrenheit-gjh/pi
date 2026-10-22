import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { createJiti } from 'jiti';
import ts from 'typescript';
const paths = await createJiti(import.meta.url).import('../lib/task-outputs.ts');
const source = readFileSync(new URL('./useTaskOutputs.ts', import.meta.url), 'utf8');
const script = new Script(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const cells = [], effects = [], requests = []; let cursor = 0, runtime = 'pi';
  const exports = {};
  script.runInNewContext({ exports, AbortController, URLSearchParams, require(id) {
    if (id === '@/lib/task-outputs') return paths;
    if (id === '@/lib/runtime-client.mjs') return {
      pageRuntime: () => runtime,
      runtimeFetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, signal: options.signal, resolve, reject })),
    };
    if (id === 'react') return {
      useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; },
      useEffect(fn, deps) {
        const i = cursor++, old = cells[i];
        if (!old || deps.some((value, j) => value !== old.deps[j])) {
          cells[i] = { deps, cleanup: old?.cleanup };
          effects.push(() => { old?.cleanup?.(); cells[i].cleanup = fn(); });
        }
      },
    };
    throw Error(id);
  } });
  return {
    requests,
    render(session = 'a', cwd = '/project', leaf = 'leaf-a', refreshKey = 0) { cursor = 0; return exports.useTaskOutputs(session, cwd, leaf, refreshKey); },
    flush() { for (const fn of effects.splice(0)) fn(); },
    async respond(index, data, ok = true) { requests[index].resolve({ ok, json: async () => data }); await tick(); },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
    runtime(value) { runtime = value; },
  };
}

test('visible view automatically fetches its selected branch and de-duplicates paths', async () => {
  const f = fixture(); assert.equal(f.render().loading, true); f.flush();
  assert.match(f.requests[0].url, /\/sessions\/a\/outputs\?leafId=leaf-a$/);
  await f.respond(0, { sessionId: 'a', paths: ['/project/report.md', '/project/report.md', '/tmp/report.pdf'] });
  const r = f.render(); assert.equal(r.loading, false); assert.equal(r.failed, false);
  assert.deepEqual(Array.from(r.paths), ['/project/report.md', '/tmp/report.pdf']);
});

test('active runs can follow the current leaf instead of freezing at an earlier history snapshot', () => {
  const f = fixture(); f.render('a', '/project', null); f.flush();
  assert.match(f.requests[0].url, /\/sessions\/a\/outputs$/);
});

test('session/branch changes abort old reads and never expose a previous conversation', async () => {
  const f = fixture(); f.render(); f.flush();
  assert.deepEqual(Array.from(f.render('b').paths), []); f.flush(); assert.equal(f.requests[0].signal.aborted, true);
  await f.respond(0, { sessionId: 'a', paths: ['/project/stale.md'] });
  assert.deepEqual(Array.from(f.render('b').paths), []);
  await f.respond(1, { sessionId: 'b', paths: ['/project/b.md'] }); assert.deepEqual(Array.from(f.render('b').paths), ['/project/b.md']);
  assert.deepEqual(Array.from(f.render('b', '/project', 'other-leaf').paths), []); f.flush(); assert.equal(f.requests[1].signal.aborted, true);
});

test('existing tool/run/focus refresh keeps current results while loading; explicit retry works', async () => {
  const f = fixture(); f.render(); f.flush(); await f.respond(0, { sessionId: 'a', paths: ['first.md'] });
  f.render('a', '/project', 'leaf-a', 1); f.flush();
  assert.deepEqual(Array.from(f.render('a', '/project', 'leaf-a', 1).paths), ['/project/first.md']);
  await f.respond(1, {}, false); let r = f.render('a', '/project', 'leaf-a', 1); assert.equal(r.failed, true); r.refresh();
  f.render('a', '/project', 'leaf-a', 1); f.flush(); await f.respond(2, { sessionId: 'a', paths: ['second.md'] });
  r = f.render('a', '/project', 'leaf-a', 1); assert.equal(r.failed, false); assert.deepEqual(Array.from(r.paths), ['/project/second.md']);
});

test('runtime and cwd isolate the scope and unmount stops outstanding reads', async () => {
  const f = fixture(); f.render(); f.flush(); await f.respond(0, { sessionId: 'a', paths: ['pi.md'] });
  f.runtime('feynman'); assert.deepEqual(Array.from(f.render().paths), []); f.flush();
  assert.equal(f.requests[0].signal.aborted, true); f.unmount(); assert.equal(f.requests[1].signal.aborted, true);
  assert.deepEqual(Array.from(f.render('a', '/another').paths), []);
});

test('rejects mismatched session responses and unsafe paths, with visible bounds', async () => {
  const f = fixture(); f.render(); f.flush(); await f.respond(0, { sessionId: 'foreign', paths: ['secret.md'] });
  assert.equal(f.render().failed, true); assert.deepEqual(Array.from(f.render().paths), []); f.render().refresh(); f.render(); f.flush();
  await f.respond(1, { sessionId: 'a', paths: ['../escape', 'https://example.com/a', ...Array.from({ length: paths.MAX_TASK_OUTPUTS + 1 }, (_, i) => `${i}.md`)] });
  assert.equal(f.render().paths.length, paths.MAX_TASK_OUTPUTS); assert.equal(f.render().truncated, true);
  assert.doesNotMatch(source, /localStorage|setInterval|\.pin\(/);
});
