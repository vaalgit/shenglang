#!/bin/bash
# usage: sweep.sh <engine> <hz> <speed> -> prints per-check failure counts over 10 seeds
mkdir -p runs
for s in 1 2 3 4 5 6 7 8 9 10; do node harness.js $1 $2 $3 runs/sw_$s $s >/dev/null; done
python3 - <<'PY'
import glob, collections
from check import check
c=collections.Counter(); n=0; tot=0
for f in sorted(glob.glob('runs/sw_*.json')):
    d,res=check(f); n+=1
    for r in res:
        tot+=1
        if not r['ok']: c[r['name']]+=1
print(f'{n} runs, pass {tot-sum(c.values())}/{tot}', dict(c))
PY
