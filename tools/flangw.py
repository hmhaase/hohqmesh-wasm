#!/usr/bin/env python3
"""flang driver wrapper: Fortran -> LLVM IR -> patch -> wasm object.

flang-wasm lowers the runtime's InquiryKeywordHash (std::uint64_t) as i32, but
the wasm runtime takes i64, so wasm-ld turns those calls into traps. Calls are
redirected to a C shim (inquire_shim.c) that widens the argument. Neither
llvm-objcopy nor wasm-ld --wrap can rename wasm symbols, hence the IR detour.
"""
import subprocess
import sys

FLANG = "/opt/flang/host/bin/flang"
CLANG = "/opt/flang/host/llvm/bin/clang"
RENAMES = {"@_FortranAioInquireLogical(": "@hohq_InquireLogical32("}

args = sys.argv[1:]
out = args[args.index("-o") + 1]
ll = out[:-2] + ".ll"
flang_args = [a for a in args if a != "-c"]
flang_args[flang_args.index("-o") + 1] = ll
subprocess.run([FLANG, "-S", "-emit-llvm", *flang_args], check=True)

with open(ll) as f:
    ir = f.read()
for old, new in RENAMES.items():
    ir = ir.replace(old, new)
with open(ll, "w") as f:
    f.write(ir)

subprocess.run([CLANG, "--target=wasm32-unknown-emscripten", "-O2", "-c", ll, "-o", out], check=True)
