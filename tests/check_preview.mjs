// Runs the boundary-preview program on every bundled example and checks that
// - it yields polylines (boundary curves, sweep curve, or the background grid box),
// - extruded and rotated outlines span the same box as the mesh HOHQMesh generates,
// - a broken control file is reported as an error rather than an empty model.
import createBoundaryPreview from '../site/boundary.js';
import createHOHQMesh from '../site/hohqmesh.js';
import { dataFiles, outputFiles } from '../site/control.js';
import { parseBoundary, parseTecplot } from '../site/viewer.js';
import fs from 'node:fs';

const UPSTREAM = new URL('../HOHQMesh/', import.meta.url).pathname;
const previewWasm = fs.readFileSync(new URL('../site/boundary.wasm', import.meta.url));
const meshWasm = fs.readFileSync(new URL('../site/hohqmesh.wasm', import.meta.url));
const { examples } = JSON.parse(fs.readFileSync(new URL('../site/examples.json', import.meta.url), 'utf8'));
// Relative to the extent of the mesh in each direction. Not tighter: on curved
// boundaries the mesh only has nodes at element corners, so its extremes can sit
// slightly inside the densely sampled outline (e.g. 3.99 vs 4.00 for a radius-4 arc).
const BOX_TOL = 0.01;

async function run(factory, wasmBinary, control, files, args) {
  let exitCode = 0;
  const log = [];
  const m = await factory({ wasmBinary, print: s => log.push(s), printErr: s => log.push(s), onExit: c => { exitCode = c; } });
  m.FS.mkdirTree('/work');
  m.FS.chdir('/work');
  for (const path of dataFiles(control)) {
    if (path.includes('/')) m.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    m.FS.writeFile(path, files[path] ?? fs.readFileSync(UPSTREAM + path));
  }
  m.FS.writeFile('/in.control', control);
  for (const path of Object.values(outputFiles(control))) {
    if (path.includes('/')) m.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
  }
  let crash = '';
  try { m.callMain([...args]); } catch (e) { crash = e.message; }
  return { m, exitCode, crash, log };
}

async function preview(control, files = {}) {
  const r = await run(createBoundaryPreview, previewWasm, control, files, ['/in.control', '/out.txt']);
  try { r.parsed = parseBoundary(r.m.FS.readFile('/out.txt', { encoding: 'utf8' })); } catch { /* not written */ }
  return r;
}

async function meshBox(control, files = {}) {
  const plot = outputFiles(control).plot;
  const r = await run(createHOHQMesh, meshWasm, control, files, ['-f', '/in.control']);
  const mesh = parseTecplot(r.m.FS.readFile(plot, { encoding: 'utf8' }));
  return box([...mesh.lines.byMaterial.values()]);
}

function box(polylines) {
  return ['x', 'y', 'z'].map(k => {
    const v = polylines.flatMap(p => p[k]).filter(Number.isFinite);
    return [Math.min(...v), Math.max(...v)];
  });
}

let failures = 0;
for (const { name, control, files = {} } of examples) {
  const { exitCode, crash, parsed } = await preview(control, files);
  const curves = parsed?.curves ?? [];
  let ok = exitCode === 0 && !crash && curves.length > 0;
  let detail = curves.length ? [...new Set(curves.map(c => c.kind))].join('+') : 'nothing';
  if (ok && ['extrusion', 'rotation'].includes(parsed.generator)) {
    const outline = box(curves);
    const mesh = await meshBox(control, files);
    const match = outline.every(([lo, hi], i) => {
      const tol = BOX_TOL * Math.max(mesh[i][1] - mesh[i][0], 1e-12);
      return Math.abs(lo - mesh[i][0]) <= tol && Math.abs(hi - mesh[i][1]) <= tol;
    });
    ok &&= match;
    detail += `, ${parsed.generator} outline ${match ? 'matches' : 'differs from'} mesh box`;
  }
  if (!ok) failures++;
  console.log(`${name.padEnd(30)} ${ok ? 'ok' : `FAIL exit ${exitCode} ${crash}`}  ${detail}`);
}

const broken = await preview(examples[0].control.replace('\\begin{MODEL}', '\\begin{MODEL'));
const reported = broken.exitCode !== 0 && broken.log.some(l => /message\s*=/.test(l));
if (!reported) failures++;
console.log(`${'syntax error is reported'.padEnd(30)} ${reported ? 'ok' : `FAIL exit ${broken.exitCode}`}`);

console.log(failures ? `${failures} preview check(s) failed` : 'all preview checks passed');
process.exit(failures ? 1 : 0);
