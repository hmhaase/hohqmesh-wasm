// Meshes every case in HOHQMesh/Benchmarks with the wasm build and compares the
// summary data (-generateTest output) against the upstream reference files.
// The upstream "-test" driver cannot be used: it calls zero-argument test
// routines through a one-argument procedure pointer, which wasm rejects.
import createHOHQMesh from '../site/hohqmesh.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../HOHQMesh/', import.meta.url).pathname;
const REL_TOL = 1e-3;

const wasmBinary = fs.readFileSync(new URL('../site/hohqmesh.wasm', import.meta.url));
const list = fs.readFileSync(ROOT + 'Benchmarks/BenchmarkFiles.txt', 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const tokens = s => s.trim().split(/\s+/);

// Integer tokens must match exactly, reals within REL_TOL; NaN or Fortran overflow
// fields (****) never match. The token text, not its value, decides integer-ness.
function matches(gotToken, expToken) {
  const g = Number(gotToken), e = Number(expToken);
  if (!Number.isFinite(g) || !Number.isFinite(e)) return false;
  if (/^[-+]?\d+$/.test(expToken)) return g === e;
  return Math.abs(g - e) <= REL_TOL * Math.max(Math.abs(e), 1e-12);
}

function copyTree(FS, src, dst) {
  FS.mkdirTree(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = `${dst}/${e.name}`;
    if (e.isDirectory()) copyTree(FS, s, d);
    else FS.writeFile(d, fs.readFileSync(s));
  }
}

let failures = 0;
for (const ctrl of list) {
  const log = [];
  let code = 0;
  const m = await createHOHQMesh({ wasmBinary, print: s => log.push(s), printErr: s => log.push(s), onExit: c => { code = c; } });
  copyTree(m.FS, ROOT + 'Benchmarks', '/repo/Benchmarks');
  copyTree(m.FS, ROOT + 'Examples', '/repo/Examples');
  m.FS.chdir('/repo');

  const text = m.FS.readFile(ctrl, { encoding: 'utf8' });
  const ref = text.match(/^[ \t]*test file name[ \t]*=[ \t]*(\S+)/m)?.[1];
  if (!ref) {
    failures++;
    console.log(`${path.basename(ctrl).padEnd(36)} FAIL no "test file name" in control file`);
    continue;
  }
  m.FS.writeFile(ctrl, text.replace(/^([ \t]*test file name[ \t]*=[ \t]*)\S+/m, '$1/result.txt'));

  const t0 = performance.now();
  let crash = '';
  try { m.callMain(['-generateTest', '-f', ctrl]); } catch (e) { crash = e.message; }
  const ms = (performance.now() - t0).toFixed(0).padStart(5);

  let verdict;
  try {
    const got = tokens(m.FS.readFile('/result.txt', { encoding: 'utf8' }));
    const exp = tokens(fs.readFileSync(ROOT + ref, 'utf8'));
    const bad = got.length !== exp.length || got.some((g, i) => !matches(g, exp[i]));
    verdict = bad ? `FAIL got ${got.join(' ')} expected ${exp.join(' ')}` : 'ok';
  } catch {
    verdict = `FAIL exit ${code} ${crash} ${log.slice(-2).join(' | ')}`;
  }
  if (verdict !== 'ok') failures++;
  console.log(`${path.basename(ctrl).padEnd(36)} ${ms} ms  ${verdict}`);
}

console.log(`${list.length - failures}/${list.length} benchmarks match`);
process.exit(failures ? 1 : 0);
