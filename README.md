# HOHQMesh in the browser

[HOHQMesh](https://github.com/trixi-framework/HOHQMesh), the high-order curved quad/hex
mesh generator, compiled to WebAssembly with LLVM Flang. The static site lets you edit a
control file, preview the model boundary, run the mesher in a Web Worker and inspect the
result with Plotly. Everything is served from this repository; nothing is loaded from a
CDN at runtime.

## Layout

| Path | Contents |
|---|---|
| `HOHQMesh/`, `FTObjectLibrary/` | Upstream sources (pinned submodules, never modified) |
| `Makefile` | Wasm link rules on top of upstream's `Makefile` |
| `build.sh` | Build (`./build.sh`) and tests (`./build.sh test`); re-runs itself in the digest-pinned `ghcr.io/r-wasm/flang-wasm` image via podman or docker, locally and in CI |
| `tools/BoundaryPreview.f90` | Small program that writes the geometry outline (boundary curves, sweep curve or background grid, in 3D mesh coordinates) with HOHQMesh's own classes and routines |
| `tools/flangw.py`, `tools/inquire_shim.c` | Compiler workaround, see below |
| `tools/patch_plotly.py` | Build-time fix for Plotly's WebGL line shaders, see below |
| `tools/make_examples.py` | Bundles `HOHQMesh/Examples` and `examples/` into the site |
| `examples/` | Examples of this repository; data files are referenced by bare name, as uploaded files are |
| `patches/` | Applied to a copy of `FTObjectLibrary/Source` in `build/ftol` |
| `site/` | Front end: `app.js` (UI), `runner.js` (killable workers), `worker.js` (runs a program per job), `control.js` (control-file keys), `viewer.js` (Tecplot/boundary parsing, Plotly), `zip.js`. Build outputs are git-ignored. `site/Examples/` mirrors the upstream layout so `file = Examples/...` paths resolve unchanged |
| `tests/check_benchmarks.mjs` | Meshes all upstream benchmarks and compares with the reference data |
| `tests/check_preview.mjs` | Runs the boundary preview on every example and on a broken control file, and checks 3D outlines against the generated meshes |

## Build and run locally

Requires `podman` or `docker`; the toolchain image is about 2.4 GB.

```bash
git submodule update --init
./build.sh
./build.sh test
python3 -m http.server 8766 --directory site
```

## Deployment

`.github/workflows/pages.yml` runs `./build.sh` and `./build.sh test` (the same
commands as locally) and deploys `site/` to GitHub Pages on every push to `main`. Pull requests are
built and checked but not deployed. In the repository settings, set
**Pages → Build and deployment → Source** to **GitHub Actions**.

To update HOHQMesh or FTObjectLibrary, move the submodule, rebuild, test and commit.
If the patch no longer applies to a new FTObjectLibrary, the build stops; drop or
regenerate the patch (it may have been merged upstream).

```bash
git -C HOHQMesh fetch && git -C HOHQMesh checkout <commit-or-tag>
git -C FTObjectLibrary fetch && git -C FTObjectLibrary checkout <commit>
./build.sh && ./build.sh test
git add HOHQMesh FTObjectLibrary
```

To move the toolchain, change `IMAGE` in `build.sh` (tag plus `@sha256:` digest).

## Using the site

- **Workspace.** The editor has a tab for the control file and one per data file (spline
  curve or topography). Data files that ship with an example are loaded as tabs too, so
  they can be inspected and edited; edits are used by the boundary preview and the mesher.
- **Open / drop.** `Open…` or dropping files on the page loads them. A `.control` file
  replaces the workspace; other files are added as data tabs. A data file is matched by
  name, so `file = Examples/2D/EastCoastUS/coastline.txt` uses an opened `coastline.txt`.
  Only text files are accepted (that is all HOHQMesh reads). The `FlowerFromFile` example
  shows the pattern: its control file says `file = flower.txt`, and dropping your own
  `flower.txt` replaces the shape.
- **Save.** `Save` (or Ctrl+S) downloads the active tab.
- **Results.** After a run, every file HOHQMesh wrote (mesh, plot, stats, boundary error
  norms) can be downloaded individually or as `all (.zip)` together with the control file.
  The zip is written in the browser without a library.
- **Formats.** Mesh: `ISM`, `ISM-V2`, `ISM-MM`, `ABAQUS`. Plot: Tecplot `skeleton` or `sem`,
  both drawn by the viewer.
- **Boundary preview.** `tools/BoundaryPreview.f90` samples the MODEL curves, the sweep
  curve, or the BACKGROUND_GRID box with HOHQMesh's own classes, lifts them onto a
  TOPOGRAPHY, validates the 3D block with `Check3DMeshParametersIntegrity` and applies a
  SIMPLE_EXTRUSION or SIMPLE_ROTATION with the routines `generate3DMesh` uses
  (`permutePosition`, `extrudedNodeLocation`, `rotatedNodeLocation`). The browser only draws
  the result; `tests/check_preview.mjs` checks that each outline spans the same box as the
  generated mesh. Curve sweeps show the cross-section and the sweep path only, since
  HOHQMesh sweeps the hex mesh with Frenet frames. Note that HOHQMesh's `sem` plot output for
  an extrusion in direction 1 or 2, or a rotation about axis 3, differs from its `skeleton`
  output (`SweepInternalDOFs` reads unpermuted coordinates); the outline follows the mesh
  nodes, i.e. the skeleton output.
- **Phones.** Below 760 px wide the page shows one panel at a time with an Editor / Plot /
  Output tab bar; a run shows Output while it runs and switches to Plot when it succeeds.
- **View.** Drag pans and scroll zooms the 2D plot; the `boundary` checkbox hides the
  boundary overlay on a mesh (2D and 3D). Panel borders can be dragged (double-click resets). The theme
  button cycles auto/light/dark. Ctrl+Enter runs. The header shows the HOHQMesh version and
  commit the site was built from and links to this repository.

## Robustness

Each run uses a fresh wasm instance in a Web Worker, so `ERROR STOP`, Fortran runtime
aborts (I/O errors, failed allocations at the 2 GB memory cap) and traps are reported in
the output panel without affecting later runs. **Stop** terminates a running mesh by
killing the worker, also while the run is still collecting its input files; boundary
previews time out after 10 s the same way, and loading another control file or example
stops a running mesh. Workers are respawned lazily, so a worker that fails to
load fails each run once instead of looping. The boundary overlay is only drawn when it was
computed from exactly the inputs that were meshed.

## Workarounds

- **INQUIRE traps.** flang-wasm lowers the runtime's 64-bit INQUIRE keyword hash as 32-bit,
  so wasm-ld replaces every `INQUIRE(..., EXIST=/OPENED=)` call with a trap. `flangw.py`
  compiles Fortran via LLVM IR and redirects those calls to `inquire_shim.c`, which widens
  the argument. Neither `llvm-objcopy` nor `wasm-ld --wrap` can rename wasm symbols. The link
  uses `--fatal-warnings`, so any new signature mismatch fails the build instead of trapping.
- **FTObjectLibrary finalization abort.** `destructObjectArray` is `RECURSIVE`, but its local
  pointer was declared `=> NULL()`, which implies `SAVE`. Nested finalization then nulls the
  descriptor the outer `DEALLOCATE` is still using. gfortran tolerates it, flang aborts.
  `patches/ftobjectlibrary-recursive-save.patch` fixes it; it should go upstream.
- **Plotly WebGL lines on some mobile GPUs (no upstream fix yet).** `scattergl` draws lines
  with regl-line2d, which encodes line breaks as NaN vertices. Its rect shader (lines up to
  2 px) has no NaN check, its miter shader returns without writing `gl_Position`, and the
  miter join turns a NaN neighbour point into NaN positions for the segments next to a
  break. All of that is undefined in WebGL; on a phone in Chrome every break was
  drawn as a line to a stray point. `tools/patch_plotly.py` patches the pinned,
  checksum-verified `plotly.min.js`: segments with a NaN end point are moved outside the clip
  volume and NaN neighbours are treated as line ends, using the NaN test the miter shader
  already has (the patched shaders pass `glslangValidator`). The related upstream report,
  [plotly.js#3522](https://github.com/plotly/plotly.js/issues/3522), was closed without a fix
  for this cause, the changelog up to 4.2.0 has none, and this patch has not been reported
  upstream yet. When updating Plotly, the build
  fails if the shader text no longer matches: check whether upstream fixed it and drop the
  patch, otherwise adapt it. `scatter3d` (gl-line3d) removes NaN segments on the CPU and is
  not affected.
- **`-test` is unusable.** The upstream test driver calls zero-argument routines through a
  one-argument procedure pointer, which wasm rejects at runtime. `tests/check_benchmarks.mjs`
  replaces it for the meshing benchmarks.

## License

MIT, see `LICENSE.md`. HOHQMesh, FTObjectLibrary (MIT) and Plotly.js (MIT) keep their own
licenses.
