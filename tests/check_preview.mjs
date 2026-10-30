// Runs the boundary-preview program on every bundled example and checks that it
// yields curves (or, for examples without a MODEL block, a background grid box),
// and that a broken control file is reported as an error rather than an empty model.
import createBoundaryPreview from '../site/boundary.js';
import { backgroundBox, dataFiles } from '../site/control.js';
import { parseBoundary } from '../site/viewer.js';
import fs from 'node:fs';

const UPSTREAM = new URL('../HOHQMesh/', import.meta.url).pathname;
const wasmBinary = fs.readFileSync(new URL('../site/boundary.wasm', import.meta.url));
const { examples } = JSON.parse(fs.readFileSync(new URL('../site/examples.json', import.meta.url), 'utf8'));

async function preview(control) {
  let exitCode = 0;
  const log = [];
  const m = await createBoundaryPreview({ wasmBinary, print: s => log.push(s), printErr: s => log.push(s), onExit: c => { exitCode = c; } });
  m.FS.mkdirTree('/work');
  m.FS.chdir('/work');
  for (const path of dataFiles(control)) {
    if (path.includes('/')) m.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    m.FS.writeFile(path, fs.readFileSync(UPSTREAM + path));
  }
  m.FS.writeFile('/in.control', control);
  let crash = '';
  try { m.callMain(['/in.control', '/out.txt']); } catch (e) { crash = e.message; }
  let curves = null;
  try { curves = parseBoundary(m.FS.readFile('/out.txt', { encoding: 'utf8' })); } catch { /* not written */ }
  return { exitCode, crash, curves, log };
}

let failures = 0;
for (const { name, control } of examples) {
  const { exitCode, crash, curves } = await preview(control);
  const box = backgroundBox(control);
  const ok = exitCode === 0 && !crash && curves && (curves.length > 0 || box);
  if (!ok) failures++;
  const what = curves?.length ? `${curves.length} curves` : box ? 'background grid' : 'nothing';
  console.log(`${name.padEnd(36)} ${ok ? 'ok' : `FAIL exit ${exitCode} ${crash}`}  ${what}`);
}

const broken = await preview(examples[0].control.replace('\\begin{MODEL}', '\\begin{MODEL'));
const reported = broken.exitCode !== 0 && broken.log.some(l => /message\s*=/.test(l));
if (!reported) failures++;
console.log(`${'syntax error is reported'.padEnd(36)} ${reported ? 'ok' : `FAIL exit ${broken.exitCode}`}`);

console.log(failures ? `${failures} preview check(s) failed` : 'all preview checks passed');
process.exit(failures ? 1 : 0);
