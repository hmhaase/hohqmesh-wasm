// Parses HOHQMesh Tecplot plot files (skeleton FEPOINT or sem POINT zones) into
// polylines and draws them with Plotly.

// Interior edges of a 3D mesh hide everything, so only faces owned by a single
// hex (the boundary surface) are drawn.
const BRICK_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
const QUAD_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]];

function boundaryFaces(faces) {
  const count = new Map();
  for (const f of faces) count.set(f.key, (count.get(f.key) ?? 0) + 1);
  return faces.filter(f => count.get(f.key) === 1);
}

function intAfter(line, key) {
  const m = line.match(new RegExp(`\\b${key}\\s*=\\s*(\\d+)`, 'i'));
  return m ? Number(m[1]) : null;
}

// Fortran list-directed output drops the E for three-digit exponents (1.0-100).
const numbers = line => line.trim().replace(/(\d)([-+]\d{3})(?=\s|,|$)/g, '$1e$2').split(/[\s,]+/).map(Number);

class Polylines {
  constructor() { this.byMaterial = new Map(); }
  add(points, material = 0) {
    if (!this.byMaterial.has(material)) this.byMaterial.set(material, { x: [], y: [], z: [] });
    const t = this.byMaterial.get(material);
    for (const p of points) { t.x.push(p[0]); t.y.push(p[1]); t.z.push(p[2]); }
    t.x.push(null); t.y.push(null); t.z.push(null);
  }
}

function parseSkeleton(lines, start) {
  const header = lines[start];
  const nNodes = intAfter(header, 'N');
  const nElems = intAfter(header, 'E');
  const isBrick = /ET\s*=\s*BRICK/i.test(header);
  const nodes = new Array(nNodes);
  let i = start + 1;
  for (let k = 0; k < nNodes; k++) nodes[k] = numbers(lines[i++]);

  let quads = [];
  for (let k = 0; k < nElems; k++) {
    const ids = numbers(lines[i++]).map(v => v - 1);
    if (!isBrick) { quads.push(ids); continue; }
    for (const f of BRICK_FACES) {
      const face = f.map(a => ids[a]);
      quads.push(Object.assign(face, { key: [...face].sort((p, q) => p - q).join(',') }));
    }
  }
  if (isBrick) quads = boundaryFaces(quads);

  const seen = new Set();
  const out = new Polylines();
  for (const ids of quads) {
    for (const [a, b] of QUAD_EDGES) {
      const lo = Math.min(ids[a], ids[b]), hi = Math.max(ids[a], ids[b]);
      const key = lo * nNodes + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      out.add([nodes[lo], nodes[hi]]);
    }
  }
  return { dim: isBrick ? 3 : 2, lines: out, nNodes, nElems };
}

// sem zones carry no connectivity, so faces are matched by rounded corner coordinates.
const pointKey = p => p.slice(0, 3).map(v => v.toFixed(8)).join(' ');

function parseSem(lines, start) {
  const out = new Polylines();
  const faces3d = [];
  let nElems = 0, dim = 2;
  let i = start;
  while (i < lines.length) {
    const header = lines[i];
    if (!/^\s*ZONE/i.test(header)) { i++; continue; }
    const I = intAfter(header, 'I'), J = intAfter(header, 'J'), K = intAfter(header, 'K') ?? 1;
    const count = I * J * K;
    const pts = new Array(count);
    for (let k = 0; k < count; k++) pts[k] = numbers(lines[i + 1 + k]);
    i += 1 + count;
    nElems++;
    const mat = pts[0][3] ?? 0;
    const at = (a, b, c) => pts[a + I * (b + J * c)];
    const n = I - 1;
    if (K === 1) {
      const loop = [];
      for (let a = 0; a <= n; a++) loop.push(at(a, 0, 0));
      for (let b = 1; b <= n; b++) loop.push(at(n, b, 0));
      for (let a = n - 1; a >= 0; a--) loop.push(at(a, n, 0));
      for (let b = n - 1; b >= 0; b--) loop.push(at(0, b, 0));
      out.add(loop, mat);
    } else {
      dim = 3;
      // Each face is a map (s, t) -> point on an (n+1)^2 patch.
      const faceMaps = [
        (s, t) => at(s, t, 0), (s, t) => at(s, t, K - 1),
        (s, t) => at(s, 0, t), (s, t) => at(s, J - 1, t),
        (s, t) => at(0, s, t), (s, t) => at(I - 1, s, t),
      ];
      for (const f of faceMaps) {
        const corners = [f(0, 0), f(n, 0), f(n, n), f(0, n)].map(pointKey);
        faces3d.push({ key: [...corners].sort().join('|'), f, n, mat });
      }
    }
  }

  const seen = new Set();
  for (const { f, n, mat } of boundaryFaces(faces3d)) {
    const range = Array.from({ length: n + 1 }, (_, t) => t);
    for (const curve of [range.map(s => f(s, 0)), range.map(t => f(n, t)), range.map(s => f(s, n)), range.map(t => f(0, t))]) {
      // Symmetric in traversal direction, so the neighbouring element's copy matches.
      const key = [curve[0], curve[n]].map(pointKey).sort().join('|') + '#' +
        [curve[n >> 1], curve[n - (n >> 1)]].map(pointKey).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.add(curve, mat);
    }
  }
  return { dim, lines: out, nNodes: null, nElems };
}

export function parseTecplot(text) {
  const lines = text.split('\n');
  const first = lines.findIndex(l => /^\s*ZONE/i.test(l));
  if (first < 0) throw new Error('No ZONE found in plot file');
  return /F\s*=\s*FEPOINT/i.test(lines[first]) ? parseSkeleton(lines, first) : parseSem(lines, first);
}

// Output of tools/BoundaryPreview.f90: "CURVE <outer|inner> <chain> | <curve>" headers
// followed by "x y" samples.
export function parseBoundary(text) {
  const curves = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const header = line.match(/^CURVE (outer|inner) (.*)$/);
    if (header) {
      cur = { kind: header[1], label: header[2].trim(), x: [], y: [] };
      curves.push(cur);
    } else if (cur && line.trim()) {
      const [x, y] = numbers(line);
      cur.x.push(x);
      cur.y.push(y);
    }
  }
  return curves;
}

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d'];
const BOUNDARY_COLORS = { outer: '#f97316', inner: '#a855f7' };

function boundaryTraces(curves, width, visible) {
  const traces = [];
  for (const kind of ['outer', 'inner']) {
    const x = [], y = [], text = [];
    for (const c of curves.filter(c => c.kind === kind)) {
      x.push(...c.x, null);
      y.push(...c.y, null);
      text.push(...c.x.map(() => c.label), null);
    }
    if (x.length) {
      traces.push({
        type: 'scattergl', mode: 'lines', x, y, text, name: `${kind} boundary`,
        hovertemplate: '%{text}<br>(%{x:.4g}, %{y:.4g})<extra></extra>',
        line: { color: BOUNDARY_COLORS[kind], width }, visible,
      });
    }
  }
  return traces;
}

// scene: { mesh?, boundary?: curves[], box? }; opts: { revision, showBoundary }.
// The same revision keeps the user's zoom across redraws (e.g. a theme change).
export function draw(el, scene, theme, { revision = 0, showBoundary = true } = {}) {
  const { mesh, boundary = [], box } = scene;
  const dim = mesh?.dim ?? 2;
  const traces = [];
  let c = 0;
  const multi = (mesh?.lines.byMaterial.size ?? 0) > 1;
  for (const [mat, t] of mesh?.lines.byMaterial ?? []) {
    const color = multi ? PALETTE[c++ % PALETTE.length] : theme.line;
    const common = { mode: 'lines', name: multi ? `material ${mat}` : 'mesh', hoverinfo: 'x+y' + (dim === 3 ? '+z' : '') };
    traces.push(dim === 3
      ? { ...common, type: 'scatter3d', x: t.x, y: t.y, z: t.z, line: { color, width: 2 } }
      : { ...common, type: 'scattergl', x: t.x, y: t.y, line: { color, width: 1 } });
  }
  if (dim === 2) {
    traces.push(...boundaryTraces(boundary, mesh ? 2.5 : 2, !mesh || showBoundary ? true : 'legendonly'));
    if (!mesh && !boundary.length && box) {
      traces.push({
        type: 'scatter', mode: 'lines', ...box, name: 'background grid',
        line: { color: theme.line, width: 1.5, dash: 'dash' }, hoverinfo: 'x+y',
      });
    }
  }
  const axis = { gridcolor: theme.grid, zerolinecolor: theme.grid, color: theme.text };
  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: theme.text, family: 'inherit' },
    margin: { l: 40, r: 10, t: 10, b: 30 },
    showlegend: traces.length > 1,
    legend: { orientation: 'h', y: 1.02, x: 0 },
    uirevision: revision,
  };
  if (dim === 3) {
    layout.scene = { aspectmode: 'data', xaxis: axis, yaxis: axis, zaxis: axis };
    layout.margin = { l: 0, r: 0, t: 0, b: 0 };
  } else {
    layout.dragmode = 'pan';
    layout.xaxis = axis;
    layout.yaxis = { ...axis, scaleanchor: 'x', scaleratio: 1 };
  }
  return Plotly.react(el, traces, layout, { responsive: true, displaylogo: false, scrollZoom: true });
}
