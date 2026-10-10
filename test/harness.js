// Drives the real app code (dsp.js + engines.js + app.js) with a synthetic GPS feed.
// Usage: node harness.js <engineId> <gpsHz> <speedField:yes|no> <outPrefix> [seed]
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const [engineId = 'i5', gpsHzArg = '10', speedField = 'yes', outPrefix = 'out', seedArg = '7'] = process.argv.slice(2);
const GPS_HZ = +gpsHzArg, SR = 44100, TICK = 0.02;

// ---------- virtual clock + DOM stubs ----------
let NOW = 0;
let tickFn = null;
const el = () => new Proxy({
  style: {}, dataset: {}, hidden: false, textContent: '', value: '',
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, setAttribute() {}, appendChild() {}, querySelector: () => el(),
  getBoundingClientRect: () => ({ width: 300, height: 240 }),
  getContext: () => new Proxy({}, { get: () => () => {} })
}, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
const sandbox = {
  document: { querySelector: () => el(), querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, documentElement: {}, visibilityState: 'visible' },
  window: {}, navigator: {}, localStorage: undefined,
  performance: { now: () => NOW * 1000 },
  setInterval: (fn) => { tickFn = fn; return 1; }, setTimeout: (fn, ms) => { timers.push([NOW + ms / 1000, fn]); },
  requestAnimationFrame: () => 0, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  addEventListener() {}, devicePixelRatio: 1
};
const timers = [];
const code = ['dsp.js', 'engines.js', 'app.js'].map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n') +
  '\nreturn { S, G, onFix, tick, EngineDSP, ENGINES, setLocal: d => { local = d; } };';
const app = new Function(...Object.keys(sandbox), code)(...Object.values(sandbox));
const { S, G, onFix, EngineDSP, ENGINES } = app;

// ---------- the drive (ground truth, Model Y long range) ----------
// Phases are what a driver does; the app never sees them, only GPS fixes.
const PH = [
  { t0: 0, t1: 3, kind: 'stop', label: '停車怠速' },
  { t0: 3, t1: 9.5, kind: 'full', label: '起步全油門' },
  { t0: 9.5, t1: 13, kind: 'lift', label: '收油滑行' },
  { t0: 13, t1: 23, kind: 'cruise', label: '定速巡航' },
  { t0: 23, t1: 29, kind: 'full', label: '匝道深踩' },
  { t0: 29, t1: 38, kind: 'lift', label: '收油動能回收' },
  { t0: 38, t1: 45, kind: 'brake', label: '煞車停車' },
  { t0: 45, t1: 50, kind: 'stop', label: '停車怠速' }
];
const DROPOUT = [18, 20];
const END = 50;
const phaseAt = t => PH.find(p => t >= p.t0 && t < p.t1) || PH[PH.length - 1];
const truth = []; // 100 Hz
{
  let v = 0, x = 0;
  for (let i = 0; i <= END * 100; i++) {
    const t = i / 100, p = phaseAt(t);
    let a = 0;
    if (p.kind === 'full') a = Math.min(6.0, 150 / Math.max(v, 1)) - (0.12 + 0.00045 * v * v);
    else if (p.kind === 'lift') a = v > 0.5 ? -1.4 - 0.00045 * v * v : 0;
    else if (p.kind === 'cruise') a = 0.18 * Math.sin(t * 0.9);
    else if (p.kind === 'brake' || p.kind === 'stop') a = v > 0 ? -3.6 : 0;
    // drivers don't snap the pedal: ease the first 0.3 s of each phase
    const ease = Math.min(1, (t - p.t0) / 0.3);
    a *= ease;
    v = Math.max(0, v + a / 100); x += v / 100;
    truth.push({ t, v, a, x, phase: p.kind });
  }
}
const truthAt = t => truth[Math.max(0, Math.min(truth.length - 1, Math.round(t * 100)))];

// ---------- GPS feed ----------
let seed = +seedArg;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
const LAT0 = 25.06, LON0 = 121.48, M_PER_DEG = 111320;
const fixes = [];
const drift = { x: 0, y: 0 };
{
  let t = 0.05;
  while (t < END) {
    if (!(t >= DROPOUT[0] && t < DROPOUT[1])) {
      const tr = truthAt(Math.max(0, t - 0.15)); // receiver latency
      // GNSS position error is a slow wander (AR(1), ~10 s correlation) plus a little white jitter
      const dtf = fixes.length ? t - fixes[fixes.length - 1].t : 1;
      const rho = Math.exp(-dtf / 10), sd = 1.5 * Math.sqrt(1 - rho * rho);
      drift.x = rho * drift.x + gauss() * sd; drift.y = rho * drift.y + gauss() * sd;
      fixes.push({
        t,
        speed: speedField === 'yes' ? Math.max(0, tr.v + gauss() * 0.25) : null,
        lat: LAT0 + (tr.x + drift.x + gauss() * 0.3) / M_PER_DEG,
        lon: LON0 + (drift.y + gauss() * 0.3) / M_PER_DEG,
        acc: 5
      });
    }
    t += 1 / GPS_HZ + (rnd() - 0.5) * 0.02;
  }
}

// ---------- run ----------
const eng = ENGINES.find(e => e.id === engineId);
const dsp = new EngineDSP(SR);
let fires = 0, pops = 0;
const origFire = dsp.fire.bind(dsp), origAdd = dsp.addPulse.bind(dsp);
dsp.addPulse = (b, amp, nz, len) => { if (amp > 1.05 && nz >= 2.2) pops++; origAdd(b, amp, nz, len); };
dsp.fire = (i, cps) => { fires++; origFire(i, cps); };
app.setLocal(dsp);
S.eng = eng; S.mode = 'gps'; S.trans = 'auto'; S.car = 'lr';
dsp.msg({ engine: eng });
// press start at t=0
S.running = true; S.startT = 0; dsp.msg({ on: true, starter: true });

const audio = new Float32Array(Math.ceil(END * SR));
const nPer = Math.round(TICK * SR);
const L = new Float32Array(nPer), R = new Float32Array(nPer);
const log = [];
let fi = 0, ai = 0, prevGear = 0;
const shifts = [];
for (let k = 0; NOW < END - 1e-9; k++) {
  NOW = k * TICK;
  while (fi < fixes.length && fixes[fi].t <= NOW) {
    const f = fixes[fi++];
    onFix({ coords: { speed: f.speed, latitude: f.lat, longitude: f.lon, accuracy: f.acc } });
  }
  for (let j = timers.length - 1; j >= 0; j--) if (timers[j][0] <= NOW) { timers[j][1](); timers.splice(j, 1); }
  const f0 = fires, p0 = pops;
  tickFn();
  dsp.process(L, R, nPer);
  let ss = 0, pk = 0, nan = 0;
  for (let i = 0; i < nPer; i++) {
    const v = L[i];
    if (!isFinite(v)) nan++;
    if (ai < audio.length) audio[ai++] = v;
    ss += v * v; pk = Math.max(pk, Math.abs(v));
  }
  const tr = truthAt(NOW);
  if (S.gear !== prevGear && S.moving) shifts.push({ t: NOW, from: prevGear + 1, to: S.gear + 1, rpmBefore: log.length ? log[log.length - 1].rpm : 0 });
  prevGear = S.gear;
  log.push({
    t: +NOW.toFixed(2), phase: tr.phase,
    vTrue: tr.v * 3.6, vEst: S.v * 3.6, aTrue: tr.a, aEst: S.a,
    gear: !S.moving ? 0 : S.gear + 1, rpm: S.rpm, load: S.load, sendLoad: S.sendLoad, cut: S.cut,
    firesHz: (fires - f0) / TICK, expectHz: dsp.on ? dsp.rpm / 120 * eng.offsets.length : 0, dspRpm: dsp.rpm,
    pops: pops - p0, rms: Math.sqrt(ss / nPer), peak: pk, nan
  });
}

// ---------- write outputs ----------
const wav = (file, data) => {
  let pk = 0; for (const v of data) pk = Math.max(pk, Math.abs(v));
  const g = pk > 0.98 ? 0.98 / pk : 1;
  const b = Buffer.alloc(44 + data.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, data[i] * g * 1.6)) * 32767 * 0.9) | 0, 44 + i * 2);
  fs.writeFileSync(file, b);
};
wav(outPrefix + '.wav', audio);
fs.writeFileSync(outPrefix + '.json', JSON.stringify({ engine: eng.id, engineName: eng.name, gpsHz: GPS_HZ, speedField, phases: PH, dropout: DROPOUT, redline: eng.redline, idle: eng.idle, cyl: eng.offsets.length, gears: eng.gears.length, fixes: fixes.map(f => ({ t: +f.t.toFixed(3), kmh: f.speed == null ? null : +(f.speed * 3.6).toFixed(2) })), shifts, log }));
console.log(`${eng.id} ${GPS_HZ}Hz speed=${speedField}: ${log.length} ticks, ${fixes.length} fixes, ${shifts.length} shifts, pops ${pops}`);
