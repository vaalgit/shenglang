import json, sys, math

def check(path):
    d = json.load(open(path))
    log, rl, idle = d['log'], d['redline'], d['idle']
    hz = d['gpsHz']
    ph = lambda r: r['phase']
    res = []
    def add(key, name, ok, detail):
        res.append({'key': key, 'name': name, 'ok': bool(ok), 'detail': detail})

    drop = d['dropout']
    moving = [r for r in log if r['vTrue'] > 1 and not (drop[0] <= r['t'] < drop[1])]
    err = math.sqrt(sum((r['vEst'] - r['vTrue']) ** 2 for r in moving) / len(moving))
    lim = 4 if hz >= 5 else 8
    add('track', '速度追蹤', err <= lim, f'平均誤差 {err:.1f} km/h（標準 ≤ {lim}）')

    hold = [abs(r['vEst'] - r['vTrue']) for r in log if drop[0] <= r['t'] < drop[1]]
    add('dropout', 'GPS 斷訊 2 秒', max(hold) <= 5, f'斷訊期間最大誤差 {max(hold):.1f} km/h（標準 ≤ 5）')

    run = [r for r in log if r['t'] > 3.2]
    lo, hi = min(r['rpm'] for r in run), max(r['rpm'] for r in run)
    add('range', '轉速範圍', lo >= idle * 0.98 and hi <= rl + 10, f'{lo:.0f}–{hi:.0f} rpm（怠速 {idle}、紅線 {rl}）')

    sh = d['shifts']
    def phase_of(t):
        for p in d['phases']:
            if p['t0'] <= t < p['t1']:
                return p
    full_ups = [s for s in sh if s['to'] > s['from'] and phase_of(s['t'])['kind'] == 'full']
    mn = min(s['rpmBefore'] for s in full_ups) if full_ups else 0
    avg = sum(s['rpmBefore'] for s in full_ups) / len(full_ups) if full_ups else 0
    add('upshift', '全油門升檔時機', full_ups and mn >= 0.7 * rl and avg >= 0.8 * rl,
        f'{len(full_ups)} 次升檔，平均 {avg:.0f}、最低 {mn:.0f} rpm（標準平均 ≥ {0.8*rl:.0f}、最低 ≥ {0.7*rl:.0f}）' if full_ups else '沒有升檔')

    hunt = []
    for a, b in zip(sh, sh[1:]):
        da, db = a['to'] - a['from'], b['to'] - b['from']
        # hunting = going back to the gear you just left while the driver's input has not changed
        if da * db < 0 and b['t'] - a['t'] < 3.0 and b['to'] == a['from'] and phase_of(a['t']) is phase_of(b['t']):
            hunt.append((a['t'], b['t']))
    cruise = [s for s in sh if 17 <= s['t'] < 23]
    add('hunt', '不會來回跳檔', not hunt and len(cruise) <= 1,
        f'3 秒內換回原檔 {len(hunt)} 次（標準 0）、穩定巡航中換檔 {len(cruise)} 次（標準 ≤ 1）')

    kdl = 1.2 if hz >= 5 else 2.5
    kd = [s for s in sh if 23 <= s['t'] <= 23 + kdl and s['to'] < s['from']]
    add('kickdown', '深踩自動降檔', bool(kd),
        (f'{kd[0]["t"]-23:.2f} 秒後從 {kd[0]["from"]} 檔降到 {kd[-1]["to"]} 檔（標準 ≤ {kdl} 秒）') if kd else f'{kdl} 秒內沒有降檔')

    settle = 1.0 if hz >= 5 else 2.0
    rl_lim = 1.0 if hz >= 5 else 2.2
    lift = [r for p in d['phases'] if p['kind'] == 'lift' for r in log if p['t0'] + settle <= r['t'] < p['t1']]
    ml = sum(r['sendLoad'] for r in lift) / len(lift)
    react = None
    detected = {}
    for p in d['phases']:
        if p['kind'] == 'lift':
            for r in log:
                if r['t'] >= p['t0'] and r['sendLoad'] < 0.05:
                    react = max(react or 0, r['t'] - p['t0']); detected[p['t0']] = r['t']; break
    # once the lift has been recognised, the gearbox must hold its gear (engine braking)
    lift_up = [s for s in sh if phase_of(s['t'])['kind'] == 'lift' and s['to'] > s['from']
               and s['t'] > detected.get(phase_of(s['t'])['t0'], 1e9) and s['rpmBefore'] < 0.9 * rl]
    add('lift', '收油判斷', ml <= 0.05 and not lift_up and react <= rl_lim,
        f'{react:.2f} 秒判斷為收油（標準 ≤ {rl_lim}），之後平均負載 {ml:.2f}，判斷出收油後升檔 {len(lift_up)} 次')

    W = 25
    worst = 0
    for i in range(0, len(log) - W, W):
        seg = [r for r in log[i:i + W] if r['t'] > 1.0]
        e = sum(r['expectHz'] for r in seg) * 0.02
        f = sum(r['firesHz'] for r in seg) * 0.02
        if e > 10:
            worst = max(worst, max(0, abs(f - e) - 1) / e)
    add('fire', '點火次數跟著轉速', worst <= 0.05, f'每 0.5 秒點火次數和轉速換算值最大差 {worst*100:.1f}%（容許 ±1 次量化誤差，標準 ≤ 5%）')

    def mean(xs): return sum(xs) / len(xs)
    rf = mean([r['rms'] for r in log if r['phase'] == 'full'])
    rc = mean([r['rms'] for r in log if r['phase'] == 'cruise'])
    add('loud', '踩越深越大聲', rf >= rc * 1.5, f'全油門音量是巡航的 {rf/rc:.1f} 倍（標準 ≥ 1.5）')

    pl = sum(r['pops'] for r in log if r['phase'] == 'lift')
    def settled(r):
        p = phase_of(r['t'])
        return r['t'] >= p['t0'] + (1.0 if hz >= 5 else 2.0)
    # pops from the intended ignition cut at an upshift (cut=True) are the shift "pop", not overrun
    pf = sum(r['pops'] for r in log if r['phase'] in ('full', 'cruise') and settled(r) and not r['cut'])
    add('pops', '收油才回火', pl > 0 and pf <= pl * 0.2, f'收油時 {pl} 響、加速和巡航時 {pf} 響（不含換檔斷油的「噗」）')

    st = [r for r in log if r['t'] >= 47]
    ok = all(abs(r['rpm'] - idle) <= idle * 0.05 and r['gear'] == 0 for r in st)
    add('stop', '停車回到怠速', ok, f'停車後 {mean([r["rpm"] for r in st]):.0f} rpm、N 檔')

    pk = max(r['peak'] for r in log); nan = sum(r['nan'] for r in log)
    add('clip', '沒有破音', nan == 0 and pk < 1.0, f'峰值 {pk:.2f}，NaN {nan} 個')
    return d, res

if __name__ == '__main__':
    for p in sys.argv[1:]:
        d, res = check(p)
        bad = [r for r in res if not r['ok']]
        print(f"== {p}: {len(res)-len(bad)}/{len(res)} 通過")
        for r in res:
            print(('  ✓ ' if r['ok'] else '  ✗ ') + r['name'] + '：' + r['detail'])
