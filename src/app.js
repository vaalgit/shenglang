const $ = s => document.querySelector(s);
const CARS = {
  rwd: { name: '後驅標準版', a0: 4.6, pm: 125 },
  lr: { name: '長程雙馬達', a0: 6.2, pm: 160 },
  perf: { name: 'Performance', a0: 8.0, pm: 185 }
};
const TIRE = 2.05;
const S = {
  eng: ENGINES[0], mode: 'sim', trans: 'auto', car: 'lr', vol: 0.7,
  running: false, startT: 0, v: 0, a: 0, gear: 0, rpm: 0, load: 0, cut: false,
  lastShift: -9, shiftDir: 0, thr: 0, thrIn: 0, brk: 0, blip: false, blipUntil: 0,
  freeRpm: 0, sendLoad: 0, gps: 'off', moving: false, coast: true, overrun: false, ovHold: 0, peak: 0, loadAtShift: 0
};
// GPS speed/acceleration tracker: a 2-state Kalman filter [speed, acceleration].
// Works for 1 Hz and 10 Hz receivers, and for browsers that only report positions.
const G = { have: false, v: 0, a: 0, t: 0, gap: 0.1, P: [[1, 0], [0, 4]], anchor: null, hasSpeed: true, watch: null };
const JERK = 15; // how quickly a driver can change acceleration (m/s^3)^2/Hz

let actx = null, node = null, local = null, master = null, audioEl = null;

function post(d) {
  if (node) node.port.postMessage(d);
  else if (local) local.msg(d);
}

async function initAudio() {
  if (actx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  actx = new AC({ latencyHint: 'interactive' });
  master = actx.createGain();
  master.gain.value = S.vol;
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.15;
  const makeup = actx.createGain(); makeup.gain.value = 1.6;
  try {
    const src = EngineDSP.toString() +
      '\nclass P extends AudioWorkletProcessor{constructor(){super();this.d=new EngineDSP(sampleRate);this.port.onmessage=e=>this.d.msg(e.data)}' +
      'process(i,o){const c=o[0];this.d.process(c[0],c[1]||c[0],c[0].length);return true}}\nregisterProcessor("engine-proc",P);';
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    await actx.audioWorklet.addModule(url);
    node = new AudioWorkletNode(actx, 'engine-proc', { outputChannelCount: [2] });
    node.connect(comp);
  } catch (err) {
    local = new EngineDSP(actx.sampleRate);
    const sp = actx.createScriptProcessor(1024, 0, 2);
    sp.onaudioprocess = ev => {
      const b = ev.outputBuffer;
      local.process(b.getChannelData(0), b.getChannelData(1), b.length);
    };
    sp.connect(comp);
    node = null;
  }
  comp.connect(makeup); makeup.connect(master);
  // Route through a media element so the car treats the page as its media source
  // (steering-wheel buttons then reach the Media Session handlers below).
  let routed = false;
  try {
    const dest = actx.createMediaStreamDestination();
    audioEl = new Audio();
    audioEl.srcObject = dest.stream;
    master.connect(dest);
    await audioEl.play();
    routed = true;
  } catch (e) {
    try { master.disconnect(); } catch (_) {}
  }
  if (!routed) master.connect(actx.destination);
  setupMediaSession();
  post({ engine: S.eng });
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    ms.metadata = new MediaMetadata({ title: S.eng.name, artist: '聲浪引擎' });
    ms.setActionHandler('nexttrack', () => shift(1, true));
    ms.setActionHandler('previoustrack', () => shift(-1, true));
    const blipOnce = () => { blipPulse(); if (audioEl) audioEl.play().catch(() => {}); };
    ms.setActionHandler('play', blipOnce);
    ms.setActionHandler('pause', blipOnce);
  } catch (e) {}
}

let wake = null;
async function keepAwake() {
  try { wake = await navigator.wakeLock.request('screen'); } catch (e) {}
}

async function toggleEngine() {
  await initAudio();
  if (actx.state === 'suspended') await actx.resume();
  if (!S.running) {
    S.running = true; S.startT = performance.now() / 1000;
    S.freeRpm = 0; S.gear = 0;
    post({ on: true, starter: true });
    keepAwake();
    if (S.mode === 'gps') startGps();
  } else {
    S.running = false;
    post({ on: false, starter: false, rpm: 0, load: 0, cut: false });
  }
  renderStart();
}

/* ---------- GPS ---------- */
function hav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function startGps() {
  if (G.watch !== null) return;
  if (!('geolocation' in navigator)) { setGps('none'); return; }
  setGps('wait');
  try {
    G.watch = navigator.geolocation.watchPosition(onFix, onGpsErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  } catch (e) { setGps('denied'); }
}
function stopGps() {
  if (G.watch !== null) { navigator.geolocation.clearWatch(G.watch); G.watch = null; }
  G.have = false; G.anchor = null; setGps('off');
}
function onFix(p) {
  const t = performance.now() / 1000;
  const c = p.coords, here = { lat: c.latitude, lon: c.longitude, t };
  setGps(c.accuracy > 40 ? 'weak' : 'ok');
  let z = c.speed, R;
  G.hasSpeed = !(z == null || isNaN(z) || z < 0);
  if (!G.hasSpeed) {
    // No speed field: derive it from two positions about 1 s apart. Windows do not overlap,
    // so each measurement carries independent error, and the filter trusts it less.
    const old = G.anchor;
    if (!old) { G.anchor = here; return; }
    const base = t - old.t;
    if (base < 0.9) return;
    G.anchor = here;
    if (base > 5) return; // too long a gap to say anything about speed
    z = hav(old, here) / base + (G.have ? G.a * base / 2 : 0);
    const pa = Math.max(2, Math.min(c.accuracy || 5, 20)) * 0.25;
    R = (pa * 1.414 / base) ** 2;
  } else {
    R = 0.35 * 0.35;
  }
  if (!G.have) {
    G.v = z; G.a = 0; G.P = [[R, 0], [0, 4]]; G.t = t; G.have = true;
  } else {
    const dt = Math.max(0.01, t - G.t), P = G.P;
    G.gap += 0.2 * (Math.min(dt, 2) - G.gap); // typical time between fixes
    // predict
    let v = G.v + G.a * dt, a = G.a;
    // slower receivers get a looser model so the estimate still reacts within one or two fixes
    const q = JERK * Math.min(4, Math.max(1, G.gap / 0.1));
    let p00 = P[0][0] + dt * (P[1][0] + P[0][1]) + dt * dt * P[1][1] + q * dt * dt * dt / 3;
    let p01 = P[0][1] + dt * P[1][1] + q * dt * dt / 2;
    let p10 = P[1][0] + dt * P[1][1] + q * dt * dt / 2;
    let p11 = P[1][1] + q * dt;
    // update with the measured speed
    const y = z - v, Sx = p00 + R, k0 = p00 / Sx, k1 = p10 / Sx;
    v += k0 * y; a += k1 * y;
    G.P = [[(1 - k0) * p00, (1 - k0) * p01], [p10 - k1 * p00, p11 - k1 * p01]];
    G.v = Math.max(0, v); G.a = Math.max(-10, Math.min(10, a)); G.t = t;
  }
}
function onGpsErr(e) {
  if (e.code === 1) { setGps('denied'); stopGpsWatchOnly(); }
  else if (e.code === 3) setGps('wait');
  else setGps('weak');
}
function stopGpsWatchOnly() {
  if (G.watch !== null) { navigator.geolocation.clearWatch(G.watch); G.watch = null; }
}
const GPS_TEXT = {
  off: ['GPS 未使用', ''],
  wait: ['等待 GPS 定位…', 'warn'],
  ok: ['GPS 已鎖定', 'good'],
  weak: ['GPS 訊號弱', 'warn'],
  denied: ['無法讀取位置', 'bad'],
  none: ['此瀏覽器沒有 GPS', 'bad']
};
function setGps(s) {
  S.gps = s;
  const el = $('#gps');
  let txt = GPS_TEXT[s][0];
  if ((s === 'ok' || s === 'weak') && G.have) txt += ` · ${(1 / G.gap).toFixed(1)} Hz${G.hasSpeed ? '' : ' · 座標推算'}`;
  if (el.textContent !== txt) el.textContent = txt;
  el.dataset.state = GPS_TEXT[s][1];
  $('#gpsHelp').hidden = s !== 'denied' && s !== 'none';
}

/* ---------- vehicle + gearbox ---------- */
const car = () => CARS[S.car];
const aMax = v => Math.min(car().a0, car().pm / Math.max(v, 1));
const drag = v => 0.12 + 0.00045 * v * v;
const rpmAt = (g, v) => v / TIRE * 60 * S.eng.gears[g] * S.eng.fd;

function shift(dir, manualKey) {
  const n = S.eng.gears.length, now = performance.now() / 1000;
  if (manualKey && S.trans === 'auto') { S.trans = 'manual'; renderSeg(); }
  const g = Math.max(0, Math.min(n - 1, S.gear + dir));
  if (g === S.gear) return;
  if (dir < 0 && rpmAt(g, S.v) > S.eng.redline * 1.02) return;
  S.gear = g; S.lastShift = now; S.shiftDir = dir; S.loadAtShift = S.load;
  if (dir < 0) S.blipUntil = now + 0.16;
}
function blipPulse() {
  const now = performance.now() / 1000;
  S.blip = true;
  setTimeout(() => { S.blip = false; }, 220);
  if (S.v > 0.5) S.blipUntil = now + 0.22;
}

let lastT = performance.now() / 1000;
function tick() {
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, now - lastT); lastT = now;
  const e = S.eng, nG = e.gears.length;

  // speed + load
  let load;
  if (S.mode === 'sim') {
    S.thr += (S.thrIn - S.thr) * Math.min(1, dt * 7);
    let a = S.thr * aMax(S.v) - (S.v > 0.1 ? drag(S.v) : 0) - S.brk * 7;
    if (S.thr < 0.05 && S.v > 0.5) a -= 1.3;
    S.v = Math.max(0, S.v + a * dt);
    if (S.v === 0 && a < 0) a = 0;
    S.a = a;
    load = S.thr;
  } else {
    let vEst = 0;
    if (G.have) vEst = Math.max(0, G.v + G.a * Math.min(now - G.t, G.gap + 0.3));
    S.v += (vEst - S.v) * Math.min(1, dt * 15);
    // with no fresh fix (tunnel, dropout) assume the car settles to a steady speed
    const stale = G.have ? now - G.t - G.gap : 0;
    S.a = G.have ? G.a * (stale > 0.5 ? Math.exp(-(stale - 0.5) / 0.4) : 1) : 0;
    load = Math.max(0, Math.min(1, (S.a + drag(S.v)) / aMax(S.v) * 1.1));
    // Overrun only when the car slows faster than it would just rolling (drag + engine braking),
    // with hysteresis so a slight downhill at cruise does not crackle.
    const coastDecel = drag(S.v) * 0.6 + 0.3;
    // ...and only once it has kept slowing for a moment, so one noisy fix cannot crackle.
    S.ovHold = S.a < -coastDecel ? S.ovHold + dt : 0;
    if (!S.overrun && S.ovHold >= 0.12) S.overrun = true;
    else if (S.overrun && S.a > -coastDecel * 0.5) S.overrun = false;
    if (S.overrun) load = 0;
    else if (S.v > 1 && load < 0.12) load = 0.12;
  }
  // standstill with hysteresis: GPS jitter of +-1 km/h at a red light must not engage a gear
  const posOnly = S.mode === 'gps' && !G.hasSpeed;
  if (!S.moving && S.v > (posOnly ? 2.0 : 1.2)) S.moving = true;
  else if (S.moving && S.v < (posOnly ? 1.2 : 0.6)) S.moving = false;
  if (!S.moving && S.mode === 'gps') load = 0;
  if (!S.running) load = 0;
  S.load += (load - S.load) * Math.min(1, dt * 8);
  const L = S.load;
  // shift points follow the pedal you held over the last moment, not every flicker of the estimate
  S.peak = Math.max(L, S.peak - 0.6 * dt);
  if (S.coast && L > 0.15) S.coast = false;
  else if (!S.coast && L < 0.06) S.coast = true;

  // gearbox
  if (S.gear > nG - 1) S.gear = nG - 1;
  const r0 = rpmAt(S.gear, S.v);
  if (S.running && S.moving) {
    if (S.trans === 'auto' && now - S.lastShift > 0.45) {
      const up = e.idle + (e.redline * 0.96 - e.idle) * (0.22 + 0.78 * Math.pow(S.peak, 1.3));
      const down = e.idle * 1.15 + e.redline * 0.45 * L * L;
      const justUp = S.shiftDir > 0 && now - S.lastShift < 1.2 && L < S.loadAtShift + 0.3;
      // Hysteresis: only shift into a gear that would not immediately want to shift back.
      const rUp = S.gear < nG - 1 ? rpmAt(S.gear + 1, S.v) : 0;
      const rDn = S.gear > 0 ? rpmAt(S.gear - 1, S.v) : Infinity;
      const pedalHeld = !S.coast && L > S.peak - 0.15;
      if (S.gear < nG - 1 && r0 > up && (pedalHeld || r0 > e.redline * 0.9) && rUp > down * 1.1 && rUp > e.idle * 1.05) {
        shift(1);
      } else if (S.gear > 0 && !justUp && r0 < down && rDn < up * 0.92 && rDn < e.redline * 0.92) {
        let g = S.gear - 1;
        if (L > 0.8) while (g > 0 && rpmAt(g - 1, S.v) < e.redline * 0.85 && rpmAt(g, S.v) < e.redline * 0.6) g--;
        shift(g - S.gear);
      }
    } else if (S.trans === 'manual' && S.gear > 0 && r0 < e.idle * 0.8) {
      shift(-1);
    }
  }
  if (!S.moving && S.gear !== 0 && S.trans === 'auto') S.gear = 0;

  // target rpm
  let rpm, sendLoad = L, cut = false;
  const sinceStart = now - S.startT;
  if (!S.running) {
    rpm = 0; sendLoad = 0;
  } else if (sinceStart < 0.85) {
    rpm = 230; sendLoad = 0.2;
  } else {
    if (!S.moving) {
      if (S.freeRpm < e.idle) S.freeRpm = e.idle;
      const rev = S.blip || (S.mode === 'sim' && S.thrIn > 0);
      S.freeRpm += (rev ? 9000 : -3800) * dt;
      const cap = e.redline * 0.72;
      if (S.freeRpm >= cap) { S.freeRpm = cap - 150 * Math.random(); cut = true; }
      S.freeRpm = Math.max(e.idle, S.freeRpm);
      rpm = S.freeRpm;
      sendLoad = rev ? 1 : (S.freeRpm > e.idle * 1.3 ? 0 : 0.08);
    } else {
      rpm = rpmAt(S.gear, S.v);
      if (S.gear === 0 && L > 0.15) rpm = Math.max(rpm, e.idle + e.idle * 1.8 * L);
      rpm = Math.max(rpm, e.idle);
      S.freeRpm = rpm;
    }
    const flare = sinceStart < 3 ? Math.max(0, 1 - (sinceStart - 0.85) / 1.6) : 0;
    rpm = Math.max(rpm, e.idle + flare * e.idle * 0.9);
    if (now < S.blipUntil) { sendLoad = 0.75; rpm += 600; }
    if (now - S.lastShift < 0.11 && S.shiftDir > 0 && L > 0.4) { cut = !!e.shiftPop; sendLoad = e.shiftPop ? 0 : L * 0.35; }
    if (rpm >= e.redline) {
      rpm = e.redline - 260 * ((now * 11) % 1);
      cut = true;
    }
  }
  S.rpm = rpm; S.cut = cut; S.sendLoad = sendLoad;
  post({ rpm, load: sendLoad, cut, starter: S.running && sinceStart < 0.85 });
}
setInterval(tick, 20);

/* ---------- tachometer ---------- */
const cv = $('#tach'), g2 = cv.getContext('2d');
let shownRpm = 0;
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function draw() {
  const rect = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const W = Math.max(10, Math.round(rect.width * dpr)), H = Math.max(10, Math.round(rect.height * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const e = S.eng, max = Math.ceil((e.redline + 600) / 1000) * 1000;
  shownRpm += (S.rpm - shownRpm) * 0.35;
  const cx = W / 2, cy = H * 0.54, R = Math.min(W, H * 1.2) * 0.43;
  const A0 = Math.PI * 0.75, SW = Math.PI * 1.5;
  const ang = r => A0 + SW * Math.min(1.02, r / max);
  g2.clearRect(0, 0, W, H);
  const ink = css('--ink'), mute = css('--mute'), amber = css('--amber'), red = css('--red'), rim = css('--rim');
  g2.lineCap = 'butt';
  g2.lineWidth = R * 0.07; g2.strokeStyle = rim;
  g2.beginPath(); g2.arc(cx, cy, R, A0, A0 + SW); g2.stroke();
  g2.strokeStyle = red; g2.globalAlpha = 0.85;
  g2.beginPath(); g2.arc(cx, cy, R, ang(e.redline), A0 + SW); g2.stroke(); g2.globalAlpha = 1;
  g2.strokeStyle = amber; g2.globalAlpha = 0.9;
  g2.beginPath(); g2.arc(cx, cy, R, A0, ang(Math.min(shownRpm, e.redline))); g2.stroke(); g2.globalAlpha = 1;
  if (shownRpm > e.redline) { g2.strokeStyle = red; g2.beginPath(); g2.arc(cx, cy, R, ang(e.redline), ang(shownRpm)); g2.stroke(); }
  for (let r = 0; r <= max; r += 500) {
    const a = ang(r), major = r % 1000 === 0;
    const r1 = R * (major ? 0.8 : 0.86), r2 = R * 0.9;
    g2.strokeStyle = r >= e.redline ? red : (major ? ink : mute);
    g2.lineWidth = major ? R * 0.022 : R * 0.012;
    g2.beginPath(); g2.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g2.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g2.stroke();
    if (major) {
      g2.fillStyle = r >= e.redline ? red : ink;
      g2.font = `600 ${Math.round(R * 0.11)}px ${css('--f-num')}`;
      g2.textAlign = 'center'; g2.textBaseline = 'middle';
      g2.fillText(String(r / 1000), cx + Math.cos(a) * R * 0.66, cy + Math.sin(a) * R * 0.66);
    }
  }
  const na = ang(shownRpm);
  g2.strokeStyle = amber; g2.lineWidth = R * 0.03; g2.lineCap = 'round';
  g2.beginPath(); g2.moveTo(cx - Math.cos(na) * R * 0.12, cy - Math.sin(na) * R * 0.12); g2.lineTo(cx + Math.cos(na) * R * 0.93, cy + Math.sin(na) * R * 0.93); g2.stroke();
  g2.fillStyle = css('--panel'); g2.beginPath(); g2.arc(cx, cy, R * 0.3, 0, Math.PI * 2); g2.fill();
  g2.strokeStyle = rim; g2.lineWidth = R * 0.015; g2.stroke();
  const gearTxt = !S.running ? '–' : (!S.moving && S.trans === 'auto') ? 'N' : (S.trans === 'manual' ? 'M' : '') + (S.gear + 1);
  g2.fillStyle = S.cut ? red : ink;
  g2.font = `700 ${Math.round(R * 0.3)}px ${css('--f-num')}`;
  g2.textAlign = 'center'; g2.textBaseline = 'middle';
  g2.fillText(gearTxt, cx, cy + R * 0.02);
  g2.fillStyle = mute; g2.font = `500 ${Math.round(R * 0.075)}px ${css('--f-num')}`;
  g2.fillText('× 1000 RPM', cx, cy + R * 0.48);
  const lamps = 7, lw = R * 0.12, sx = cx - (lamps - 1) * lw * 0.7;
  for (let i = 0; i < lamps; i++) {
    const th = e.redline * (0.72 + i * 0.04);
    const lit = S.running && shownRpm >= th;
    g2.fillStyle = lit ? (i < 3 ? amber : red) : rim;
    g2.beginPath(); g2.arc(sx + i * lw * 1.4, cy - R * 1.08, lw * 0.32, 0, Math.PI * 2); g2.fill();
  }
  $('#spd').textContent = Math.round(S.v * 3.6);
  $('#rpmNum').textContent = S.running ? Math.round(shownRpm / 10) * 10 : 0;
  $('#loadBar').style.transform = `scaleX(${S.running ? S.load.toFixed(3) : 0})`;
  $('#loadTxt').textContent = !S.running ? '熄火' : S.cut ? '斷油' : S.load < 0.05 && shownRpm > S.eng.idle * 1.3 ? '收油回火' : S.load > 0.75 ? '全油門' : S.load > 0.2 ? '加速' : '巡航';
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

/* ---------- UI ---------- */
function renderEngines() {
  const box = $('#engines');
  box.innerHTML = '';
  ENGINES.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'eng'; b.id = 'eng-' + e.id;
    b.setAttribute('aria-pressed', String(e === S.eng));
    b.innerHTML = `<span class="eng-name"></span><span class="eng-meta"></span><span class="eng-note"></span>`;
    b.querySelector('.eng-name').textContent = e.name;
    b.querySelector('.eng-meta').textContent = `${e.power} · 紅線 ${e.redline.toLocaleString()} · ${e.box}`;
    b.querySelector('.eng-note').textContent = e.note;
    b.addEventListener('click', () => pickEngine(e));
    box.appendChild(b);
  });
}
function pickEngine(e) {
  S.eng = e;
  if (S.gear > e.gears.length - 1) S.gear = e.gears.length - 1;
  post({ engine: e });
  if (S.running) { S.startT = performance.now() / 1000 - 0.86; }
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: e.name, artist: '聲浪引擎' }); } catch (_) {}
  document.querySelectorAll('.eng').forEach(b => b.setAttribute('aria-pressed', String(b.id === 'eng-' + e.id)));
  save();
}
function renderStart() {
  const b = $('#start');
  b.textContent = S.running ? '熄火' : '發動引擎';
  b.classList.toggle('on', S.running);
}
function renderSeg() {
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)));
  document.querySelectorAll('[data-trans]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trans === S.trans)));
  $('#simPad').hidden = S.mode !== 'sim';
  $('#upBtn').hidden = $('#downBtn').hidden = S.trans !== 'manual';
}
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
  S.mode = b.dataset.mode;
  S.thrIn = 0; S.brk = 0;
  if (S.mode === 'gps') { if (S.running) startGps(); else setGps('off'); }
  else stopGps();
  renderSeg(); save();
}));
document.querySelectorAll('[data-trans]').forEach(b => b.addEventListener('click', () => {
  S.trans = b.dataset.trans; renderSeg(); save();
}));
$('#car').addEventListener('change', ev => { S.car = ev.target.value; save(); });
$('#vol').addEventListener('input', ev => {
  S.vol = +ev.target.value;
  if (master) master.gain.setTargetAtTime(S.vol, actx.currentTime, 0.05);
  save();
});
$('#start').addEventListener('click', toggleEngine);
function hold(el, on, off) {
  el.addEventListener('pointerdown', ev => { ev.preventDefault(); el.setPointerCapture?.(ev.pointerId); el.classList.add('down'); on(); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => el.addEventListener(t, () => { el.classList.remove('down'); off(); }));
}
hold($('#gas'), () => { S.thrIn = 1; }, () => { S.thrIn = 0; });
hold($('#brake'), () => { S.brk = 1; }, () => { S.brk = 0; });
hold($('#blip'), () => { S.blip = true; if (S.v > 0.5) S.blipUntil = performance.now() / 1000 + 0.25; }, () => { S.blip = false; });
$('#upBtn').addEventListener('click', () => shift(1, true));
$('#downBtn').addEventListener('click', () => shift(-1, true));
const keys = {};
addEventListener('keydown', ev => {
  if (ev.target.closest && ev.target.closest('select,input')) return;
  if (keys[ev.code]) return; keys[ev.code] = true;
  if (ev.code === 'ArrowUp' || ev.code === 'KeyW') { if (S.mode === 'sim') S.thrIn = 1; ev.preventDefault(); }
  else if (ev.code === 'ArrowDown' || ev.code === 'KeyS') { S.brk = 1; ev.preventDefault(); }
  else if (ev.code === 'Space') { S.blip = true; ev.preventDefault(); }
  else if (ev.code === 'ArrowRight' || ev.code === 'KeyE') shift(1, true);
  else if (ev.code === 'ArrowLeft' || ev.code === 'KeyQ') shift(-1, true);
});
addEventListener('keyup', ev => {
  keys[ev.code] = false;
  if (ev.code === 'ArrowUp' || ev.code === 'KeyW') S.thrIn = 0;
  else if (ev.code === 'ArrowDown' || ev.code === 'KeyS') S.brk = 0;
  else if (ev.code === 'Space') S.blip = false;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.running) { keepAwake(); if (actx) actx.resume(); }
});
function save() {
  try { localStorage.setItem('shenglang', JSON.stringify({ e: S.eng.id, m: S.mode, t: S.trans, c: S.car, v: S.vol })); } catch (e) {}
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem('shenglang') || 'null');
    if (!d) return;
    S.eng = ENGINES.find(x => x.id === d.e) || S.eng;
    if (d.m) S.mode = d.m;
    if (d.t) S.trans = d.t;
    if (CARS[d.c]) S.car = d.c;
    if (typeof d.v === 'number') S.vol = d.v;
  } catch (e) {}
}
load();
$('#car').value = S.car; $('#vol').value = S.vol;
renderEngines(); renderSeg(); renderStart(); setGps('off');
