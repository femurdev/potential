#!/usr/bin/env python3
import sys
import json
import subprocess
import os

if len(sys.argv) < 2:
    print('Usage: python3 test_emit_compile.py <ir.json>')
    sys.exit(2)

ir = sys.argv[1]
if not os.path.exists(ir):
    print('IR file not found:', ir)
    sys.exit(2)

# run validator
print('Running validator...')
res = subprocess.run(['node','compiler/validator.js', ir], capture_output=True, text=True)
print(res.stdout)
if res.returncode != 0:
    print('Validator failed:', res.stderr)
    sys.exit(res.returncode)

# emit C++
print('Emitting C++...')
out_cpp = 'out_test.cpp'
with open(out_cpp, 'w') as f:
    res = subprocess.run(['node','compiler/cpp_emitter.js', ir], capture_output=True, text=True)
    if res.returncode != 0:
        print('Emitter failed:', res.stderr)
        sys.exit(res.returncode)
    f.write(res.stdout)

print('Generated C++:\n')
print(open(out_cpp).read())

# compile
print('Compiling...')
exe = 'out_test'
res = subprocess.run(['g++', out_cpp, '-std=c++17', '-O2', '-o', exe], capture_output=True, text=True)
if res.returncode != 0:
    print('Compile failed:', res.stderr)
    sys.exit(res.returncode)

# run
print('Running binary...')
res = subprocess.run(['./' + exe], capture_output=True, text=True)
print('Exit code:', res.returncode)
print('Stdout:\n', res.stdout)
print('Stderr:\n', res.stderr)

# success
sys.exit(res.returncode)
