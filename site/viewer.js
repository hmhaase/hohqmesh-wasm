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

// WebGL must never see NaN (see toWalks); Fortran writes **** for numbers that do
// not fit, which would parse as NaN.
function finite(values, what) {
  if (!values.every(Number.isFinite)) throw new Error(`${what} contains a non-finite number (NaN or Fortran **** overflow)`);
  return values;
}

// Fortran list-directed output drops the E for three-digit exponents (1.0-100).
const numbers = line => line.trim().replace(/(\d)([-+]\d{3})(?=\s|,|$)/g, '$1e$2').split(/[\s,]+/).map(Number);

// Point lists ([x, y, z]) grouped by material.
class Polylines {
  constructor() { this.byMaterial = new Map(); }
  add(points, material = 0) {
    if (!this.byMaterial.has(material)) this.byMaterial.set(material, []);
    this.byMaterial.get(material).push(points);
  }
}

// Joins polylines that share end points into continuous walks: a depth-first
// traversal that runs along every polyline and back again. Plotly's WebGL traces
// mark line breaks with NaN vertices, and GLSL ES leaves NaN undefined (GPUs may
// treat it as 0, drawing every break as a line to one point), so the data handed
// to WebGL must contain no breaks. Retraced segments are invisible.
export function toWalks(polylines) {
  // Same tolerance as the sem edge deduplication (pointKey).
  const key = p => [p[0], p[1], p[2] ?? 0].map(v => v.toFixed(8)).join(' ');
  const ends = polylines.map(pl => [key(pl[0]), key(pl[pl.length - 1])]);
  const adjacent = new Map();
  ends.forEach(([a, b], i) => {
    for (const k of a === b ? [a] : [a, b]) {
      if (!adjacent.has(k)) adjacent.set(k, []);
      adjacent.get(k).push(i);
    }
  });
  const used = new Uint8Array(polylines.length);
  const walks = [];
  for (let first = 0; first < polylines.length; first++) {
    if (used[first]) continue;
    const walk = [polylines[first][0]];
    let forwardEnd = 1;
    const stack = [{ node: ends[first][0], next: 0, back: null }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = adjacent.get(top.node);
      while (top.next < edges.length && used[edges[top.next]]) top.next++;
      if (top.next < edges.length) {
        const e = edges[top.next];
        used[e] = 1;
        const forward = ends[e][0] === top.node ? polylines[e] : [...polylines[e]].reverse();
        for (let i = 1; i < forward.length; i++) walk.push(forward[i]);
        forwardEnd = walk.length;
        stack.push({ node: key(forward[forward.length - 1]), next: 0, back: forward });
      } else {
        stack.pop();
        if (top.back) for (let i = top.back.length - 2; i >= 0; i--) walk.push(top.back[i]);
      }
    }
    // The final retrace back to the start draws nothing new (and would double dashes).
    walk.length = forwardEnd;
    walks.push(walk);
  }
  return walks;
}

// One Plotly trace per walk; the traces of a group share one legend entry.
function walkTraces(polylines, dim, common) {
  return toWalks(polylines).map((walk, i) => {
    const t = { ...common, showlegend: i === 0, x: walk.map(p => p[0]), y: walk.map(p => p[1]) };
    if (dim === 3) t.z = walk.map(p => p[2]);
    if (common.text !== undefined) t.text = walk.map(p => p[3]);
    return t;
  });
}

function parseSkeleton(lines, start) {
  const header = lines[start];
  const nNodes = intAfter(header, 'N');
  const nElems = intAfter(header, 'E');
  const isBrick = /ET\s*=\s*BRICK/i.test(header);
  const nodes = new Array(nNodes);
  let i = start + 1;
  for (let k = 0; k < nNodes; k++) nodes[k] = finite(numbers(lines[i++]), 'plot file');

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
  const faces2d = [];
  let nElems = 0, dim = 2;
  let i = start;
  while (i < lines.length) {
    const header = lines[i];
    if (!/^\s*ZONE/i.test(header)) { i++; continue; }
    const I = intAfter(header, 'I'), J = intAfter(header, 'J'), K = intAfter(header, 'K') ?? 1;
    const count = I * J * K;
    const pts = new Array(count);
    for (let k = 0; k < count; k++) pts[k] = finite(numbers(lines[i + 1 + k]), 'plot file');
    i += 1 + count;
    nElems++;
    const mat = pts[0][3] ?? 0;
    const at = (a, b, c) => pts[a + I * (b + J * c)];
    const n = I - 1;
    if (K === 1) {
      faces2d.push({ f: (s, t) => at(s, t, 0), n, mat });
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
  for (const { f, n, mat } of [...faces2d, ...boundaryFaces(faces3d)]) {
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

// Output of tools/BoundaryPreview.f90: a "GENERATOR <name>" line, then per polyline a
// "CURVE <kind> <chain> | <curve>" header followed by "x y z" rows. 3D outlines are
// already in mesh coordinates.
export function parseBoundary(text) {
  let generator = 'none';
  const curves = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const gen = line.match(/^GENERATOR (\w+)/);
    const header = line.match(/^CURVE (outer|inner|box|sweep|section|rail) (.*)$/);
    if (gen) {
      generator = gen[1];
    } else if (header) {
      cur = { kind: header[1], label: header[2].trim(), x: [], y: [], z: [] };
      curves.push(cur);
    } else if (cur && line.trim()) {
      const [x, y, z = 0] = finite(numbers(line), 'boundary preview');
      cur.x.push(x);
      cur.y.push(y);
      cur.z.push(z);
    }
  }
  return { generator, curves: curves.filter(c => c.x.length >= 2) };
}

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d'];
const BOUNDARY_STYLE = {
  outer: { name: 'outer boundary', color: '#f97316' },
  inner: { name: 'inner boundary', color: '#a855f7' },
  box: { name: 'background grid', color: '#94a3b8', dash: 'dash' },
  sweep: { name: 'sweep curve', color: '#16a34a' },
  section: { name: 'cross-section (before sweep)', color: '#f97316', dash: 'dash' },
  rail: { name: 'extent', color: '#94a3b8', dash: 'dot' },
};

function boundaryTraces(curves, dim, width, visible) {
  const traces = [];
  for (const [kind, style] of Object.entries(BOUNDARY_STYLE)) {
    const polylines = curves.filter(c => c.kind === kind).map(c => c.x.map((_, i) => [c.x[i], c.y[i], c.z[i], c.label]));
    if (!polylines.length) continue;
    // Plotly draws dashed scatter3d lines as scattered fragments; 3D stays solid.
    const line = { color: style.color, width: kind === 'rail' ? 1.5 : width, dash: dim === 3 ? undefined : style.dash };
    traces.push(...walkTraces(polylines, dim, {
      type: dim === 3 ? 'scatter3d' : 'scattergl', mode: 'lines', text: '', name: style.name, legendgroup: kind, line, visible,
      hovertemplate: dim === 3 ? '%{text}<br>(%{x:.4g}, %{y:.4g}, %{z:.4g})<extra></extra>' : '%{text}<br>(%{x:.4g}, %{y:.4g})<extra></extra>',
    }));
  }
  return traces;
}

// scene: { mesh?, boundary?: polylines, dim? }; opts: { revision, showBoundary }.
// The same revision keeps the user's zoom across redraws (e.g. a theme change).
export function draw(el, scene, theme, { revision = 0, showBoundary = true } = {}) {
  const { mesh } = scene;
  // The cross-section is not in mesh coordinates, so it is only shown before meshing.
  const boundary = (scene.boundary ?? []).filter(c => !mesh || c.kind !== 'section');
  const dim = mesh?.dim ?? scene.dim ?? 2;
  const traces = [];
  let c = 0;
  const multi = (mesh?.lines.byMaterial.size ?? 0) > 1;
  for (const [mat, polylines] of mesh?.lines.byMaterial ?? []) {
    const color = multi ? PALETTE[c++ % PALETTE.length] : theme.line;
    const name = multi ? `material ${mat}` : 'mesh';
    traces.push(...walkTraces(polylines, dim, {
      type: dim === 3 ? 'scatter3d' : 'scattergl', mode: 'lines', name, legendgroup: name,
      hoverinfo: 'x+y' + (dim === 3 ? '+z' : ''), line: { color, width: dim === 3 ? 2 : 1 },
    }));
  }
  traces.push(...boundaryTraces(boundary, dim, mesh ? 3 : 2, !mesh || showBoundary ? true : 'legendonly'));
  const axis = { gridcolor: theme.grid, zerolinecolor: theme.grid, color: theme.text };
  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: theme.text, family: 'inherit' },
    margin: { l: 40, r: 10, t: 10, b: 30 },
    showlegend: new Set(traces.map(t => t.legendgroup)).size > 1,
    // On narrow plots a top legend collides with the toolbar.
    legend: el.clientWidth < 500 ? { orientation: 'h', x: 0, y: -0.12, yanchor: 'top' } : { orientation: 'h', y: 1.02, x: 0 },
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
  const touch = matchMedia('(pointer: coarse)').matches;
  return Plotly.react(el, traces, layout, {
    responsive: true, displaylogo: false, scrollZoom: true,
    // Without hover on touch screens the toolbar would never appear.
    displayModeBar: touch ? true : 'hover',
  });
}
