import { parseTecplot, parseBoundary, draw } from './viewer.js';
import { basename, dataFiles } from './control.js';
import { Runner } from './runner.js';
import { makeZip } from './zip.js';

const PREVIEW_DEBOUNCE_MS = 400;
const PREVIEW_TIMEOUT_MS = 10000;
const THEMES = ['auto', 'light', 'dark'];

const $ = id => document.getElementById(id);
const els = {
  example: $('example'), editor: $('editor'), tabs: $('tabs'), run: $('run'), status: $('status'),
  log: $('log'), plot: $('plot'), downloads: $('downloads'), meshInfo: $('meshInfo'),
  open: $('open'), save: $('save'), theme: $('theme'), version: $('version'),
  boundaryToggle: $('boundaryToggle'), boundaryToggleLabel: $('boundaryToggleLabel'),
  splitV: $('splitV'), splitH: $('splitH'), outputDot: $('outputDot'),
};

const mesher = new Runner('worker.js');
const previewer = new Runner('worker.js');

// Editor workspace: the control file plus data files, keyed by bare file name.
// `generation` changes whenever the workspace is replaced, so async work started
// for an older workspace can tell that its result no longer applies.
const workspace = { control: { name: 'untitled.control', text: '' }, files: new Map(), generation: 0 };
let activeTab = 'control';
const scrollPos = new Map();

// Last preview result together with the inputs it was computed from, so a mesh is
// only overlaid with the boundary of the same inputs.
let preview = { key: null, curves: [] };
// True from the moment Run is pressed, before the mesher worker is busy, so a Stop or
// a workspace change while inputs are still being resolved is not missed.
let meshing = false;
let stopRequested = false;
let lastView = null;
let lastRun = null;
let revision = 0;
const blobUrls = [];

const cleanCrash = msg => msg.replace(/ Build with -sASSERTIONS.*$/, '');

// ---------- persisted preferences ----------

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

// ---------- theme ----------

let themeMode = load('theme', 'auto');

function applyTheme(mode) {
  themeMode = mode;
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  store('theme', mode);
  els.theme.textContent = `Theme: ${mode}`;
  if (lastView) redraw();
}

function plotTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = name => css.getPropertyValue(name).trim();
  return { text: v('--text'), grid: v('--grid'), line: v('--line') };
}

// ---------- status, log, plot ----------

function setStatus(text, cls = '') {
  els.status.textContent = text;
  els.status.className = cls;
}

function appendLog(line, err = false) {
  const node = err ? Object.assign(document.createElement('span'), { className: 'err' }) : document.createTextNode('');
  node.textContent = line + '\n';
  els.log.appendChild(node);
}

function showMessage(message, info) {
  lastView = null;
  els.boundaryToggleLabel.hidden = true;
  Plotly.purge(els.plot);
  els.plot.innerHTML = '';
  els.plot.appendChild(Object.assign(document.createElement('div'), { className: 'empty', textContent: message }));
  els.meshInfo.textContent = info;
}

function show(scene, info) {
  lastView = { scene, info };
  revision++;
  Plotly.purge(els.plot);
  els.plot.innerHTML = '';
  redraw();
}

function redraw() {
  const { scene, info } = lastView;
  els.meshInfo.textContent = info;
  els.boundaryToggleLabel.hidden = !(scene.mesh && scene.boundary?.length);
  draw(els.plot, scene, plotTheme(), { revision, showBoundary: els.boundaryToggle.checked });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function clearDownloads() {
  els.downloads.textContent = '';
  blobUrls.splice(0).forEach(URL.revokeObjectURL);
}

function renderDownloads(outputs) {
  clearDownloads();
  if (!outputs.length) return;
  for (const f of outputs) {
    const url = URL.createObjectURL(new Blob([f.text], { type: 'text/plain' }));
    blobUrls.push(url);
    const name = basename(f.name);
    els.downloads.appendChild(Object.assign(document.createElement('a'), { className: 'dl', href: url, download: name, textContent: name, title: f.name }));
  }
  const zip = Object.assign(document.createElement('button'), { className: 'link', textContent: 'all (.zip)' });
  zip.onclick = downloadAll;
  els.downloads.appendChild(zip);
}

async function downloadAll() {
  const { control, outputs } = lastRun;
  const used = new Set([control.name]);
  const entries = [{ name: control.name, data: control.text }];
  for (const f of outputs) {
    let name = basename(f.name);
    if (used.has(name)) name = f.name.replace(/^\/+/, '');
    used.add(name);
    entries.push({ name, data: f.text });
  }
  downloadBlob(await makeZip(entries), control.name.replace(/\.control$/i, '') + '.zip');
}

function setRunning(running) {
  els.run.textContent = running ? 'Stop' : 'Run';
  els.run.classList.toggle('stop', running);
}

// ---------- editor tabs ----------

function activeDoc() {
  return activeTab === 'control' ? workspace.control : { name: activeTab, text: workspace.files.get(activeTab) };
}

function renderTabs() {
  els.tabs.textContent = '';
  const tab = (key, label, kind, closable) => {
    const el = Object.assign(document.createElement('div'), { className: 'tab' + (key === activeTab ? ' active' : '') });
    el.setAttribute('role', 'tab');
    el.title = label;
    el.append(Object.assign(document.createElement('span'), { className: 'kind', textContent: kind }), label);
    el.onclick = () => selectTab(key);
    if (closable) {
      const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: `Remove ${label}` });
      x.onclick = e => { e.stopPropagation(); removeFile(key); };
      el.appendChild(x);
    }
    els.tabs.appendChild(el);
  };
  tab('control', workspace.control.name, 'control', false);
  for (const name of workspace.files.keys()) tab(name, name, 'data', true);
}

function selectTab(key) {
  scrollPos.set(activeTab, els.editor.scrollTop);
  activeTab = key;
  els.editor.value = activeDoc().text;
  els.editor.scrollTop = scrollPos.get(key) ?? 0;
  renderTabs();
}

function removeFile(name) {
  workspace.files.delete(name);
  scrollPos.delete(name);
  if (activeTab === name) activeTab = 'control';
  selectTab(activeTab);
  schedulePreview();
}

// Starts a new workspace; a mesh run for the old one is stopped so its results
// cannot land on the new one.
function resetWorkspace(controlName, controlText) {
  stopMeshing();
  workspace.generation++;
  workspace.files.clear();
  workspace.control = { name: controlName, text: controlText };
  scrollPos.clear();
  activeTab = 'control';
  els.editor.value = controlText;
  els.editor.scrollTop = 0;
  els.log.textContent = '';
  clearDownloads();
  renderTabs();
}

function onEdit() {
  if (activeTab === 'control') workspace.control.text = els.editor.value;
  else workspace.files.set(activeTab, els.editor.value);
  schedulePreview();
}

// ---------- data files ----------

// Files shipped with the site (example data), fetched once per path.
const siteData = new Map();
function fetchSiteData(path) {
  if (!siteData.has(path)) {
    siteData.set(path, fetch(path).then(r => (r.ok ? r.text() : null)).catch(() => null));
  }
  return siteData.get(path);
}

// Data files referenced by the control file that ship with the site are pulled into
// the workspace so they can be inspected and edited like opened files.
async function addReferencedData() {
  const generation = workspace.generation;
  for (const path of dataFiles(workspace.control.text)) {
    const name = basename(path);
    if (workspace.files.has(name)) continue;
    const text = await fetchSiteData(path);
    if (workspace.generation !== generation) return;
    if (text !== null && !workspace.files.has(name)) workspace.files.set(name, text);
  }
  renderTabs();
}

// Contents for every data file the control file references: a workspace file with
// the same name wins, otherwise the site's copy.
async function resolveInputs(control) {
  const inputs = {};
  const missing = [];
  for (const path of dataFiles(control)) {
    const text = workspace.files.get(basename(path)) ?? await fetchSiteData(path);
    if (text === null) missing.push(path);
    else inputs[path] = text;
  }
  return { inputs, missing };
}

const inputsKey = (control, inputs) =>
  [control, ...Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1)).flat()].join('\0');

// ---------- opening files ----------

async function readText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) throw new Error(`${file.name} looks binary; HOHQMesh only reads text files`);
  return new TextDecoder().decode(bytes);
}

async function openFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const controls = files.filter(f => /\.control$/i.test(f.name));
  const data = files.filter(f => !controls.includes(f));
  try {
    const texts = await Promise.all(data.map(readText));
    if (controls.length) {
      resetWorkspace(controls[0].name, await readText(controls[0]));
      els.example.value = '';
      if (controls.length > 1) setStatus(`opened ${controls[0].name}; ignored ${controls.length - 1} more .control file(s)`, 'err');
    }
    data.forEach((f, i) => workspace.files.set(f.name, texts[i]));
    if (controls.length) await addReferencedData();
    selectTab(controls.length || !data.length ? 'control' : data[0].name);
  } catch (e) {
    setStatus(e.message, 'err');
    renderTabs();
  }
  schedulePreview();
}

function saveActive() {
  const doc = activeDoc();
  downloadBlob(new Blob([doc.text], { type: 'text/plain' }), doc.name);
}

// ---------- preview and meshing ----------

// Computes the boundary for the current workspace. The result is always kept for
// the mesh overlay; it is only displayed when no mesh run is in progress.
async function runPreview() {
  const control = workspace.control.text;
  const { inputs } = await resolveInputs(control);
  const key = inputsKey(control, inputs);
  const result = await previewer.run({ program: 'boundary', control, inputs }, { timeoutMs: PREVIEW_TIMEOUT_MS });
  if (result.superseded || result.stopped) return;

  const ok = !result.crash && result.exitCode === 0 && result.files.boundary;
  const { generator, curves } = ok ? parseBoundary(result.files.boundary.text) : { generator: 'none', curves: [] };
  preview = { key, curves };
  if (meshing || key !== inputsKey(workspace.control.text, (await resolveInputs(workspace.control.text)).inputs)) return;

  if (ok) {
    const what = curves.some(c => c.kind === 'outer' || c.kind === 'inner' || c.kind === 'section') ? 'boundary curves'
      : curves.some(c => c.kind === 'box') ? 'background grid (no boundary curves)' : 'no boundary curves';
    const kind = generator === 'none' ? '' : generator === 'sweep' ? '3D sweep: cross-section and path · ' : `3D ${generator} · `;
    show({ boundary: curves, dim: generator === 'none' ? 2 : 3 }, `Boundary preview · ${kind}${what}`);
  } else {
    const lines = result.log ?? [];
    const reason = lines.map(l => l.match(/message\s*=\s*(.*)/)?.[1]).find(Boolean)
      ?? lines.map(l => l.match(/fatal Fortran runtime error\(.*?\):\s*(.*)/)?.[1]).find(Boolean)
      ?? lines.map(l => l.match(/ERROR STOP:?\s*(.*)/)?.[1]).find(Boolean)
      ?? (result.crash ? cleanCrash(result.crash) : `exit ${result.exitCode}`);
    showMessage('Fix the input files or press Run to see the full error', `Boundary preview failed: ${reason.trim()}`);
  }
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
}

function stopMeshing() {
  if (!meshing) return;
  stopRequested = true;
  mesher.stop();
  // A run waits for its overlay preview after meshing; Stop cancels that wait too.
  previewer.stop();
}

async function run() {
  if (meshing) { stopMeshing(); return; }
  meshing = true;
  stopRequested = false;
  clearTimeout(previewTimer);
  setRunning(true);
  els.log.textContent = '';
  clearDownloads();
  setStatus('meshing…');
  if (phone.matches) setView('output');
  const t0 = performance.now();
  const ticker = setInterval(() => setStatus(`meshing… ${((performance.now() - t0) / 1000).toFixed(0)} s`), 1000);

  const generation = workspace.generation;
  const control = { ...workspace.control };
  const { inputs, missing } = await resolveInputs(control.text);
  for (const path of missing) appendLog(`Data file not found: ${path} (open it via "Open…" or drop it on the page)`, true);
  const key = inputsKey(control.text, inputs);
  // The preview runs in its own worker and takes milliseconds; start it alongside
  // the mesh if the overlay would otherwise be stale.
  const pendingPreview = preview.key === key ? null : runPreview();

  const result = stopRequested
    ? { crash: 'stopped by user', stopped: true, exitCode: -1, ms: 0, files: {}, outputs: [] }
    : await mesher.run({ program: 'mesh', control: control.text, inputs }, { onLog: appendLog });
  // Still `meshing` while the overlay preview finishes, so nothing can start or
  // load in between and have this run's results painted over it.
  await pendingPreview;
  meshing = false;
  clearInterval(ticker);
  setRunning(false);
  if (workspace.generation !== generation) {
    setStatus('stopped: another file or example was loaded', 'err');
    return;
  }
  finish(result, control, preview.key === key ? preview.curves : []);
}

function finish({ exitCode, crash, stopped, ms, files, outputs }, control, boundary) {
  els.log.scrollTop = els.log.scrollHeight;
  lastRun = { control, outputs };
  renderDownloads(outputs);
  if (crash && !stopped) appendLog(`[runtime] ${cleanCrash(crash)}`, true);
  const ok = !crash && exitCode === 0;
  setStatus(
    stopped ? 'stopped' : ok ? `done in ${(ms / 1000).toFixed(2)} s` : crash ? 'crashed' : `failed (exit ${exitCode})`,
    ok ? 'ok' : 'err',
  );

  if (!ok && !stopped && phone.matches && document.querySelector('main').dataset.view !== 'output') els.outputDot.hidden = false;
  if (!files.plot) {
    showMessage(stopped ? 'Stopped' : ok ? 'No plot file written (plot file name = none?)' : 'Meshing failed, see output', 'Mesh');
    return;
  }
  try {
    const mesh = parseTecplot(files.plot.text);
    const nodes = mesh.nNodes != null ? `${mesh.nNodes.toLocaleString()} nodes · ` : '';
    show({ mesh, boundary }, `${mesh.dim}D mesh · ${nodes}${mesh.nElems.toLocaleString()} elements`);
    if (phone.matches && ok) setView('plot');
  } catch (e) {
    appendLog(`[viewer] ${e.message}`, true);
  }
}

// ---------- examples ----------

async function loadExamples() {
  const { hohqmeshVersion, hohqmeshCommit, examples } = await (await fetch('examples.json')).json();
  const commit = hohqmeshCommit ? ` (${hohqmeshCommit.slice(0, 7)})` : '';
  els.version.textContent = `HOHQMesh ${hohqmeshVersion ?? ''}${commit}`.trim();
  if (hohqmeshCommit) els.version.href = `https://github.com/trixi-framework/HOHQMesh/commit/${hohqmeshCommit}`;
  els.example.appendChild(Object.assign(new Option('(opened file)', ''), { disabled: true, hidden: true }));
  const groups = {};
  for (const ex of examples) {
    groups[ex.dim] ??= Object.assign(document.createElement('optgroup'), { label: ex.dim });
    groups[ex.dim].appendChild(new Option(ex.name.split('/')[1], ex.name));
  }
  for (const dim of ['2D', '3D']) if (groups[dim]) els.example.appendChild(groups[dim]);
  const byName = Object.fromEntries(examples.map(e => [e.name, e]));

  const loadExample = async name => {
    const ex = byName[name];
    resetWorkspace(`${name.split('/')[1]}.control`, ex.control);
    for (const [file, text] of Object.entries(ex.files ?? {})) workspace.files.set(file, text);
    await addReferencedData();
    runPreview();
  };
  els.example.onchange = () => loadExample(els.example.value);
  els.example.value = examples[0].name;
  await loadExample(examples[0].name);
}

// ---------- phone layout ----------

const phone = matchMedia('(max-width: 760px)');

function setView(view) {
  document.querySelector('main').dataset.view = view;
  for (const b of document.querySelectorAll('#viewTabs button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  if (view === 'output') els.outputDot.hidden = true;
  // Plotly cannot measure a hidden panel: size it once visible, then redraw so the
  // legend placement follows the new width. Both keep the user's zoom.
  if (view === 'plot' && lastView) Plotly.Plots.resize(els.plot).then(() => { if (lastView) redraw(); });
}

for (const b of document.querySelectorAll('#viewTabs button')) b.onclick = () => setView(b.dataset.view);
phone.addEventListener('change', () => { if (lastView) redraw(); });

// ---------- resizable panels ----------

function makeSplitter(handle, cssVar, axis, container, bounds) {
  const root = document.documentElement;
  const saved = load(cssVar, null);
  if (saved) root.style.setProperty(cssVar, saved);
  const setPx = px => root.style.setProperty(cssVar, `${Math.round(px)}px`);

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* drag still works without capture */ }
    handle.classList.add('active');
    document.body.classList.add('resizing');
    const rect = container().getBoundingClientRect();
    const move = ev => {
      const pos = axis === 'x' ? ev.clientX - rect.left : ev.clientY - rect.top;
      const size = axis === 'x' ? rect.width : rect.height;
      setPx(Math.min(Math.max(pos, bounds.min), size - bounds.reserve));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      store(cssVar, root.style.getPropertyValue(cssVar));
      Plotly.Plots.resize(els.plot);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => {
    root.style.removeProperty(cssVar);
    store(cssVar, '');
    Plotly.Plots.resize(els.plot);
  });
}

// ---------- wiring ----------

els.open.onchange = async () => { await openFiles(els.open.files); els.open.value = ''; };
els.save.onclick = saveActive;
els.run.onclick = run;
els.theme.onclick = () => applyTheme(THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length]);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themeMode === 'auto' && lastView) redraw(); });
els.boundaryToggle.checked = load('showBoundary', 'true') === 'true';
els.boundaryToggle.onchange = () => { store('showBoundary', String(els.boundaryToggle.checked)); if (lastView) redraw(); };

makeSplitter(els.splitV, '--left-width', 'x', () => document.querySelector('main'), { min: 260, reserve: 312 });
makeSplitter(els.splitH, '--editor-height', 'y', () => els.splitH.parentElement, { min: 120, reserve: 92 });

els.editor.addEventListener('input', onEdit);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!meshing) run(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveActive(); }
});

let dragDepth = 0;
document.addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  openFiles(e.dataTransfer.files);
});

applyTheme(themeMode);
await loadExamples();
setStatus('ready');
