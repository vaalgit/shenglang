import subprocess, json, collections
import os; os.makedirs("runs", exist_ok=True)
from check import check
cfgs = [('i5',10,'yes'),('f6',10,'yes'),('i6',10,'yes'),('v8',10,'yes'),('i4',10,'yes'),('i5',1,'yes'),('i5',10,'no'),('i5',1,'no')]
out = []
for e,hz,sp in cfgs:
    per = collections.Counter(); total = 0; runs = 0
    for s in range(1, 11):
        f = f'runs/m_{e}_{hz}_{sp}_{s}'
        subprocess.run(['node','harness.js',e,str(hz),sp,f,str(s)], check=True, capture_output=True)
        d, res = check(f + '.json'); runs += 1
        for r in res:
            per[r['key']] += r['ok']; total += 1
        subprocess.run(['rm','-f',f+'.wav'])
    out.append({'engine': e, 'hz': hz, 'speed': sp, 'runs': runs, 'per': per, 'names': {r['key']: r['name'] for r in res}})
    print(e, hz, sp, sum(per.values()), '/', total, flush=True)
json.dump(out, open('runs/matrix.json','w'), ensure_ascii=False)
