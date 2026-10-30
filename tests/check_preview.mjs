// Runs the boundary-preview program on every bundled example and checks that
// - it yields polylines (boundary curves, sweep curve, or the background grid box),
// - extruded and rotated outlines span the same box as the mesh HOHQMesh generates,
// - a broken control file is reported as an error rather than an empty model,
// - the walks drawn instead of NaN-separated lines (see toWalks) contain exactly the
//   segments of the outlines and meshes, and only finite numbers.
import createBoundaryPreview from '../site/boundary.js';
import createHOHQMesh from '../site/hohqmesh.js';
import { dataFiles, outputFiles } from '../site/control.js';
import { parseBoundary, parseTecplot, toWalks } from '../site/viewer.js';
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

async function mesh(control, files = {}) {
  const plot = outputFiles(control).plot;
  const r = await run(createHOHQMesh, meshWasm, control, files, ['-f', '/in.control']);
  return parseTecplot(r.m.FS.readFile(plot, { encoding: 'utf8' }));
}

function meshBox(parsed) {
  const points = [...parsed.lines.byMaterial.values()].flat(2);
  return box([{ x: points.map(q => q[0]), y: points.map(q => q[1]), z: points.map(q => q[2]) }]);
}

const segmentKey = (a, b) => [a, b].map(p => [0, 1, 2].map(k => (p[k] ?? 0).toFixed(8)).join(' ')).sort().join('|');

function walksCover(polylines) {
  const want = new Set(), got = new Set();
  for (const pl of polylines) for (let i = 1; i < pl.length; i++) want.add(segmentKey(pl[i - 1], pl[i]));
  for (const walk of toWalks(polylines)) {
    if (!walk.every(p => [0, 1, 2].every(k => Number.isFinite(p[k] ?? 0)))) return false;
    for (let i = 1; i < walk.length; i++) got.add(segmentKey(walk[i - 1], walk[i]));
  }
  return want.size === got.size && [...want].every(k => got.has(k));
}

const curvePolylines = curves => curves.map(c => c.x.map((_, i) => [c.x[i], c.y[i], c.z[i]]));

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
  for (const kind of new Set(curves.map(c => c.kind))) {
    if (!walksCover(curvePolylines(curves.filter(c => c.kind === kind)))) { ok = false; detail += `, walks wrong for ${kind}`; }
  }
  if (ok && ['extrusion', 'rotation'].includes(parsed.generator)) {
    const outline = box(curves);
    const meshed = await mesh(control, files);
    const meshExtent = meshBox(meshed);
    const match = outline.every(([lo, hi], i) => {
      const tol = BOX_TOL * Math.max(meshExtent[i][1] - meshExtent[i][0], 1e-12);
      return Math.abs(lo - meshExtent[i][0]) <= tol && Math.abs(hi - meshExtent[i][1]) <= tol;
    });
    const meshWalks = [...meshed.lines.byMaterial.values()].every(walksCover);
    ok &&= match && meshWalks;
    detail += `, ${parsed.generator} outline ${match ? 'matches' : 'differs from'} mesh box`;
    if (!meshWalks) detail += ', mesh walks wrong';
  }
  if (!ok) failures++;
  console.log(`${name.padEnd(30)} ${ok ? 'ok' : `FAIL exit ${exitCode} ${crash}`}  ${detail}`);
}

// One 2D mesh in both plot formats, multi-material.
for (const format of ['skeleton', 'sem']) {
  const ex = examples.find(e => e.name === '2D/BoneAndMarrow');
  const parsed = await mesh(ex.control.replace(/plot file format = \w+/, `plot file format = ${format}`));
  const ok = [...parsed.lines.byMaterial.values()].every(walksCover);
  if (!ok) failures++;
  console.log(`${`2D/BoneAndMarrow ${format} walks`.padEnd(30)} ${ok ? 'ok' : 'FAIL'}  ${parsed.lines.byMaterial.size} materials`);
}

const broken = await preview(examples[0].control.replace('\\begin{MODEL}', '\\begin{MODEL'));
const reported = broken.exitCode !== 0 && broken.log.some(l => /message\s*=/.test(l));
if (!reported) failures++;
console.log(`${'syntax error is reported'.padEnd(30)} ${reported ? 'ok' : `FAIL exit ${broken.exitCode}`}`);

console.log(failures ? `${failures} preview check(s) failed` : 'all preview checks passed');
process.exit(failures ? 1 : 0);
