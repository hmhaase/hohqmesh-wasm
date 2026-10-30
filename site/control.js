// Minimal reading of HOHQMesh control files, mirroring its reader
// (IO/ControlFileReader.f90): the key is the exact text before the first "=",
// the value the trimmed rest of the line. tools/make_examples.py mirrors DATA_KEY.

const OUTPUT_KEY = /^[ \t]*(mesh|plot|stats) file name[ \t]*=[ \t]*(.*?)[ \t]*$/gm;
const DATA_KEY = /^[ \t]*(?:data )?file[ \t]*=[ \t]*(.*?)[ \t]*$/gm;

// Names HOHQMesh uses when the key is missing (Project/MeshProject.f90).
const DEFAULT_OUTPUTS = { mesh: 'MeshFile.mesh', plot: 'PlotFile.tec' };

export function outputFiles(control) {
  const out = { ...DEFAULT_OUTPUTS };
  for (const [, kind, value] of control.matchAll(OUTPUT_KEY)) {
    if (value && value.toLowerCase() !== 'none') out[kind] = value;
    else delete out[kind];
  }
  return out;
}

export function dataFiles(control) {
  return [...control.matchAll(DATA_KEY)].map(m => m[1]).filter(Boolean);
}

export const basename = p => p.slice(p.lastIndexOf('/') + 1);

// Absolute, normalised path of `p` relative to directory `cwd`.
export function resolvePath(cwd, p) {
  const parts = [];
  for (const seg of (p.startsWith('/') ? p : `${cwd}/${p}`).split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return '/' + parts.join('/');
}
