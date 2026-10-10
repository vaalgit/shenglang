class EngineDSP {
  constructor(sr) {
    this.sr = sr;
    this.phase = 0; this.rpm = 0; this.tRpm = 0; this.load = 0; this.tLoad = 0;
    this.on = false; this.cut = false; this.starter = false;
    this.kR = 1 - Math.exp(-1 / (sr * 0.025));
    this.kL = 1 - Math.exp(-1 / (sr * 0.04));
    this.kBu = 1 - Math.exp(-1 / (sr * 0.55));
    this.kBd = 1 - Math.exp(-1 / (sr * 0.25));
    this.kBov = Math.exp(-1 / (sr * 0.3));
    this.P = 48;
    this.pT = new Float32Array(this.P); this.pLen = new Float32Array(this.P);
    this.pAmp = new Float32Array(this.P); this.pNz = new Float32Array(this.P);
    this.pBank = new Uint8Array(this.P); this.pAct = new Uint8Array(this.P);
    this.boost = 0; this.bov = 0; this.peakLoad = 0; this.wPh = 0; this.stPh = 0;
    this.h1 = 0; this.h2 = 0;
    this.lpL = 0; this.lpL2 = 0; this.lpR = 0; this.lpR2 = 0;
    this.dxL = 0; this.dyL = 0; this.dxR = 0; this.dyR = 0;
    this.seed = 22222; this.eng = null; this.preGain = 1; this.ovT = 0;
  }
  rand() {
    let x = this.seed | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x;
    return (x >>> 0) / 4294967296;
  }
  bp(f, q) {
    const w = 2 * Math.PI * Math.min(f, this.sr * 0.45) / this.sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return { b0: al / a0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0, z1: 0, z2: 0 };
  }
  run(f, x) {
    const y = f.b0 * x + f.z1;
    f.z1 = -f.a1 * y + f.z2;
    f.z2 = f.b2 * x - f.a2 * y;
    return y;
  }
  setEngine(e) {
    this.eng = e;
    this.n = e.offsets.length;
    this.off = e.offsets.map(o => ((o % 1) + 1) % 1);
    this.nb = Math.max.apply(null, e.banks) + 1;
    const pipes = Array.isArray(e.pipeHz) ? e.pipeHz : [e.pipeHz, e.pipeHz * 1.07];
    this.res = []; this.dl = []; this.di = [];
    for (let b = 0; b < this.nb; b++) {
      this.res.push(e.res.map(r => Object.assign(this.bp(r[0] * (b ? 1.04 : 1), r[1]), { g: r[2] })));
      this.dl.push(new Float32Array(Math.max(8, Math.round(this.sr / pipes[b]))));
      this.di.push(0);
    }
    this.bovF = this.bp(2600, 1.3);
    this.pAct.fill(0);
    this.preGain = e.level || 1;
  }
  addPulse(b, amp, nz, len) {
    for (let k = 0; k < this.P; k++) {
      if (!this.pAct[k]) {
        this.pAct[k] = 1; this.pT[k] = 0; this.pLen[k] = Math.max(2, len);
        this.pAmp[k] = amp; this.pNz[k] = nz; this.pBank[k] = b; return;
      }
    }
  }
  fire(i, cps) {
    const e = this.eng, sr = this.sr, b = e.banks[i];
    const L = this.load, rN = Math.min(1.1, this.rpm / e.redline);
    if (this.cut && this.rand() < 0.7) {
      if (this.rand() < 0.2 * e.pops) this.addPulse(b, 1.5 + this.rand(), 2.4, 0.003 * sr);
      return;
    }
    let amp = (0.3 + 0.7 * Math.pow(L, 0.8)) * e.gains[i] * (0.92 + 0.16 * this.rand()) * (0.75 + 0.45 * rN);
    if (this.starter) amp *= this.rand() < 0.5 ? 0 : 0.35;
    const interval = sr / (cps * this.n);
    const len = Math.min(Math.max(e.pulse * interval, 0.0012 * sr), 0.012 * sr);
    const nz = e.noise * (L < 0.08 ? 2.2 : 1);
    this.addPulse(b, amp, nz, len);
    // Overrun crackle: a burst right after lifting off, thinning out as the exhaust cools.
    // Rate is in pops per second, converted to a chance per firing.
    const popRate = (3 + 12 * rN) * e.pops * (Math.exp(-this.ovT / 1.2) + 0.12);
    if (L < 0.08 && this.rpm > 2200 && !this.starter && this.rand() < popRate / (cps * this.n)) {
      this.addPulse(b, 1.1 + 0.9 * this.rand(), 2.5, 0.0025 * sr + this.rand() * 0.004 * sr);
    }
  }
  process(outL, outR, N) {
    const e = this.eng;
    if (!e) { outL.fill(0); if (outR !== outL) outR.fill(0); return; }
    const sr = this.sr, TAU = Math.PI * 2;
    for (let s = 0; s < N; s++) {
      this.rpm += (this.tRpm - this.rpm) * this.kR;
      this.load += (this.tLoad - this.load) * this.kL;
      const rN = Math.min(1.1, this.rpm / e.redline), L = this.load;
      this.ovT = L < 0.08 ? this.ovT + 1 / sr : 0;
      const cps = Math.max(0, this.rpm) / 120;
      const p0 = this.phase, p1 = p0 + cps / sr;
      if (this.on && cps > 0.5) {
        for (let i = 0; i < this.n; i++) {
          const o = this.off[i];
          if ((o > p0 && o <= p1) || (o + 1 > p0 && o + 1 <= p1)) this.fire(i, cps);
        }
      }
      this.phase = p1 >= 1 ? p1 - 1 : p1;

      let x0 = 0, x1 = 0;
      for (let k = 0; k < this.P; k++) {
        if (!this.pAct[k]) continue;
        const u = this.pT[k] / this.pLen[k];
        let v = Math.sin(Math.PI * u) * (1 - 0.45 * u) * this.pAmp[k];
        if (this.pNz[k] > 0) v += (this.rand() * 2 - 1) * this.pAmp[k] * this.pNz[k] * (1 - u) * 0.5;
        if (this.pBank[k]) x1 += v; else x0 += v;
        if (++this.pT[k] >= this.pLen[k]) this.pAct[k] = 0;
      }

      const y0 = this.bank(0, x0);
      const y1 = this.nb > 1 ? this.bank(1, x1) : 0;

      // intake hiss
      const wn = this.rand() * 2 - 1;
      this.h1 += 0.35 * (wn - this.h1);
      this.h2 += 0.03 * (this.h1 - this.h2);
      const hiss = (this.h1 - this.h2) * (this.on ? 0.012 + 0.05 * L * rN : 0);

      // turbo
      let tb = 0;
      if (e.turbo > 0) {
        const tgt = this.on && L > 0.3 ? L * Math.min(1, rN * 1.6) : 0;
        this.boost += (tgt - this.boost) * (tgt > this.boost ? this.kBu : this.kBd);
        if (L > 0.55) this.peakLoad = 1;
        if (this.peakLoad && L < 0.15) {
          if (this.boost > 0.35) this.bov = Math.max(this.bov, this.boost);
          this.peakLoad = 0;
        }
        this.wPh += TAU * (1800 + 5200 * this.boost) / sr;
        if (this.wPh > TAU) this.wPh -= TAU;
        tb = Math.sin(this.wPh) * this.boost * this.boost * 0.03 * e.turbo;
        if (this.bov > 0.001) {
          tb += this.run(this.bovF, wn) * this.bov * 0.5 * e.turbo;
          this.bov *= this.kBov;
        }
      }

      // starter motor whine
      let st = 0;
      if (this.starter) {
        this.stPh += TAU * (160 + this.rpm * 0.4) / sr;
        if (this.stPh > TAU) this.stPh -= TAU;
        st = (Math.sin(this.stPh) + 0.4 * Math.sin(this.stPh * 3)) * 0.05;
      }

      const drive = e.drive * (0.6 + 0.6 * L) * this.preGain;
      const sl = this.nb > 1 ? y0 * 0.68 + y1 * 0.32 : y0;
      const srr = this.nb > 1 ? y0 * 0.32 + y1 * 0.68 : y0;
      let l = Math.tanh(sl * drive) * 0.55 + hiss + tb + st;
      let r = Math.tanh(srr * drive) * 0.55 + hiss + tb + st;

      const fc = 700 + 7000 * e.bright * (0.3 + 0.7 * Math.min(1, rN)) * (0.6 + 0.4 * L);
      const a = 1 - Math.exp(-TAU * fc / sr);
      this.lpL += a * (l - this.lpL); this.lpL2 += a * (this.lpL - this.lpL2);
      this.lpR += a * (r - this.lpR); this.lpR2 += a * (this.lpR - this.lpR2);
      l = this.lpL2; r = this.lpR2;

      const oL = l - this.dxL + 0.995 * this.dyL; this.dxL = l; this.dyL = oL;
      const oR = r - this.dxR + 0.995 * this.dyR; this.dxR = r; this.dyR = oR;
      outL[s] = oL;
      if (outR !== outL) outR[s] = oR;
    }
  }
  bank(b, x) {
    const e = this.eng, rs = this.res[b];
    let y = x * e.direct;
    for (let j = 0; j < rs.length; j++) y += this.run(rs[j], x) * rs[j].g;
    const d = this.dl[b]; let i = this.di[b];
    const c = y + e.pipeFb * d[i];
    d[i] = c; i++; if (i >= d.length) i = 0; this.di[b] = i;
    return c;
  }
  msg(d) {
    if (d.engine) this.setEngine(d.engine);
    if ('rpm' in d) this.tRpm = d.rpm;
    if ('load' in d) this.tLoad = d.load;
    if ('on' in d) this.on = d.on;
    if ('cut' in d) this.cut = d.cut;
    if ('starter' in d) this.starter = d.starter;
  }
}
