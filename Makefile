# WebAssembly build of HOHQMesh. Run from build/ via build.sh, inside
# ghcr.io/r-wasm/flang-wasm. Object lists and dependencies come from upstream.
override HOHQMESHPATH = ../HOHQMesh
# build.sh keeps a patched copy of FTObjectLibrary in build/ftol.
override FTOLPATH = ftol
include $(HOHQMESHPATH)/Makefile

FC = ../tools/flangw.py
FFLAGS = -cpp -O2
RUNTIME = /opt/flang/wasm/lib/libFortranRuntime.a
LIBOBJS = $(filter-out HOHQMeshMain.o,$(OBJS)) inquire_shim.o

# --fatal-warnings: a wasm-ld signature mismatch means a call that traps at runtime.
EMFLAGS = -O2 -sMODULARIZE -sEXPORT_ES6 \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=16MB \
  -sENVIRONMENT=web,worker,node \
  -Wl,--fatal-warnings

.PHONY: wasm
wasm: ../site/hohqmesh.js ../site/boundary.js

inquire_shim.o: ../tools/inquire_shim.c
	emcc -O2 -c -o $@ $<

BoundaryPreview.o: ../tools/BoundaryPreview.f90 $(filter-out HOHQMeshMain.o,$(OBJS))
	$(FC) -c $(FFLAGS) -o $@ $<

../site/hohqmesh.js: HOHQMeshMain.o $(LIBOBJS)
	emcc $(EMFLAGS) -sEXPORT_NAME=createHOHQMesh -o $@ $^ $(RUNTIME)

../site/boundary.js: BoundaryPreview.o $(LIBOBJS)
	emcc $(EMFLAGS) -sEXPORT_NAME=createBoundaryPreview -o $@ $^ $(RUNTIME)
