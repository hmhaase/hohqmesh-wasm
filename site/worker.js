// Runs one HOHQMesh program (mesher or boundary preview) per message. Every run gets
// a fresh wasm instance: Fortran module state and an exited or aborted runtime
// cannot be reused, and a crash must not leak into the next run.
import createHOHQMesh from './hohqmesh.js';
import createBoundaryPreview from './boundary.js';
import { outputFiles, resolvePath } from './control.js';

const WORKDIR = '/work';
// Outside WORKDIR so no workspace file name can collide with them.
const INTERNAL = '/hohqmesh-web';
const CONTROL = `${INTERNAL}/run.control`;
const BOUNDARY = `${INTERNAL}/boundary.txt`;
const SKIP_DIRS = new Set(['/dev', '/proc', INTERNAL]);

const PROGRAMS = {
  mesh: {
    factory: createHOHQMesh,
    wasm: 'hohqmesh.wasm',
    args: ['-f', CONTROL],
    outputs: control => outputFiles(control),
    streamLog: true,
  },
  boundary: {
    factory: createBoundaryPreview,
    wasm: 'boundary.wasm',
    args: [CONTROL, BOUNDARY],
    outputs: () => ({ boundary: BOUNDARY }),
    streamLog: false,
  },
};
const compiled = {};

const post = (type, data = {}) => self.postMessage({ type, ...data });
const dirname = p => p.slice(0, p.lastIndexOf('/'));

function compile(name) {
  compiled[name] ??= WebAssembly.compileStreaming(fetch(new URL(PROGRAMS[name].wasm, import.meta.url)))
    .catch(e => { delete compiled[name]; throw e; });
  return compiled[name];
}

function writeFile(m, path, data) {
  m.FS.mkdirTree(dirname(path) || '/');
  m.FS.writeFile(path, data);
}

// path -> mtime of every regular file, so outputs can be found wherever HOHQMesh
// wrote them (default names, absolute or ../ paths).
function snapshot(m, dir = '/', out = new Map()) {
  for (const name of m.FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = dir === '/' ? `/${name}` : `${dir}/${name}`;
    if (SKIP_DIRS.has(full)) continue;
    const st = m.FS.stat(full);
    if (m.FS.isDir(st.mode)) snapshot(m, full, out);
    else if (m.FS.isFile(st.mode)) out.set(full, st.mtime.getTime());
  }
  return out;
}

const displayName = p => p.startsWith(`${WORKDIR}/`) ? p.slice(WORKDIR.length + 1) : p;

// `inputs` maps each path the control file references to its contents; the app
// resolves them (workspace files, site data) before posting the run.
async function run({ id, program, control, inputs = {} }) {
  const prog = PROGRAMS[program];
  const lines = [];
  const log = (line, err = false) => prog.streamLog ? post('log', { id, line, err }) : lines.push(line);

  const module = await compile(program);
  let exitCode = 0;
  const m = await prog.factory({
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then(inst => done(inst));
      return {};
    },
    print: line => log(line),
    printErr: line => log(line, true),
    onExit: code => { exitCode = code; },
  });

  m.FS.mkdirTree(WORKDIR);
  m.FS.chdir(WORKDIR);
  for (const [path, text] of Object.entries(inputs)) writeFile(m, resolvePath(WORKDIR, path), text);
  writeFile(m, CONTROL, control);

  const expected = Object.entries(prog.outputs(control)).map(([kind, p]) => [resolvePath(WORKDIR, p), kind]);
  for (const [path] of expected) m.FS.mkdirTree(dirname(path) || '/');
  const before = snapshot(m);

  const t0 = performance.now();
  let crash = null;
  try {
    m.callMain([...prog.args]);
  } catch (e) {
    crash = String(e?.message ?? e);
  }
  const ms = performance.now() - t0;

  const kindOf = new Map(expected);
  const files = {};
  const outputs = [];
  const read = path => ({ name: displayName(path), text: m.FS.readFile(path, { encoding: 'utf8' }) });
  for (const [path, mtime] of snapshot(m)) {
    if (before.get(path) === mtime) continue;
    const file = read(path);
    outputs.push(file);
    if (kindOf.has(path)) files[kindOf.get(path)] = file;
  }
  for (const [path, kind] of kindOf) {
    if (!path.startsWith(`${INTERNAL}/`)) continue;
    try { files[kind] = read(path); } catch { /* not written */ }
  }
  post('done', { id, exitCode, crash, ms, files, outputs, log: prog.streamLog ? undefined : lines });
}

let current = null;
self.onmessage = e => {
  const { id } = e.data;
  current = id;
  run(e.data)
    .catch(err => post('done', { id, exitCode: -1, crash: String(err?.message ?? err), ms: 0, files: {}, outputs: [] }))
    .finally(() => { if (current === id) current = null; });
};
// Emscripten can rethrow aborts asynchronously; report them for the run still in
// progress, and ignore late ones from a run that already finished.
self.addEventListener('unhandledrejection', e => {
  if (current === null) return;
  post('done', { id: current, exitCode: -1, crash: String(e.reason?.message ?? e.reason), ms: 0, files: {}, outputs: [] });
});
