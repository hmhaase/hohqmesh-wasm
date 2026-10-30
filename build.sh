#!/bin/bash
# Usage: ./build.sh         build the static site into site/
#        ./build.sh test    run the test suite against the built site
#
# Runs directly inside the flang-wasm image; anywhere else (local machine, CI
# runner) it re-runs itself in that image via podman or docker.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=ghcr.io/r-wasm/flang-wasm:v23.1.4@sha256:867e82a9b2d389b64426182cc7d9225e89391b7050b237729b27bfd8f44647a2
PLOTLY_VERSION=2.35.2
PLOTLY_SHA256=6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603

if [ ! -x /opt/flang/host/bin/flang ]; then
  if command -v podman >/dev/null; then
    exec podman run --rm -v "$PWD":/src:Z -w /src "$IMAGE" ./build.sh "$@"
  elif command -v docker >/dev/null; then
    # Rootful docker writes as root; HOST_OWNER lets the build hand files back.
    exec docker run --rm -e HOST_OWNER="$(id -u):$(id -g)" -v "$PWD":/src -w /src "$IMAGE" ./build.sh "$@"
  fi
  echo "need podman or docker" >&2
  exit 1
fi

if [ -n "${HOST_OWNER:-}" ]; then
  trap 'chown -R "$HOST_OWNER" build site 2>/dev/null || true' EXIT
fi

. /opt/emsdk/emsdk_env.sh >/dev/null 2>&1

if [ "${1:-}" = test ]; then
  node tests/check_benchmarks.mjs
  node tests/check_preview.mjs
  exit 0
fi

[ -f HOHQMesh/Makefile ] && [ -d FTObjectLibrary/Source ] || {
  echo "submodules missing: git submodule update --init" >&2; exit 1; }

# Patch a copy so the submodule stays clean; refresh it only when the sources or
# patches change. cp -r gives the copy fresh mtimes, so make recompiles from it.
ftol=build/ftol
stamp=$(find FTObjectLibrary/Source patches -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)
if [ "$(cat "$ftol/.stamp" 2>/dev/null)" != "$stamp" ]; then
  rm -rf "$ftol"
  mkdir -p "$ftol"
  cp -r FTObjectLibrary/Source "$ftol/"
  for p in patches/*.patch; do patch -d "$ftol" -p1 -s < "$p"; done
  echo "$stamp" > "$ftol/.stamp"
fi

export EM_LLVM_ROOT=/opt/flang/host/llvm/bin
mkdir -p build site/vendor
make -C build -f ../Makefile -j"$(nproc)" wasm

python3 tools/make_examples.py

# The pinned upstream file is kept in build/; the site gets the patched copy
# (see tools/patch_plotly.py).
plotly=build/plotly-$PLOTLY_VERSION.min.js
if ! echo "$PLOTLY_SHA256  $plotly" | sha256sum -c --status >/dev/null 2>&1; then
  curl -fsSL -o "$plotly" "https://cdn.jsdelivr.net/npm/plotly.js-dist-min@$PLOTLY_VERSION/plotly.min.js"
  echo "$PLOTLY_SHA256  $plotly" | sha256sum -c --quiet
fi
python3 tools/patch_plotly.py "$plotly" site/vendor/plotly.min.js
