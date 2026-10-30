/* ═══════════════════════════════════════════
   LIMITER PROCESSOR — AudioWorklet (V2)
   Brickwall look-ahead peak limiter, stereo-linked.

   Algorithm (per sample):
     req[n]  = |x| > thr ? thr/|x| : 1          (gain needed)
     hold[n] = min(req[n-L+1 .. n])             (sliding-window min)
     rel[n]  = instant down, smooth release up
     g[n]    = mean(rel[n-L+1 .. n])            (box filter = smooth attack)
     y[n]    = x[n-L+1] * g[n]                  (signal delayed L-1)
   Guarantees |y| <= thr (no overshoot) with ~5 ms latency.
   Reports min gain (GR) to the main thread ~30×/s.
   ═══════════════════════════════════════════ */

class SNLimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = Math.max(16, Math.round(sampleRate * 0.005)); // 5 ms look-ahead
    this.thr = Math.pow(10, -1 / 20);                        // -1 dBFS
    this.on = true;
    this._setRelease(0.15);

    // Delay lines (2 ch)
    this.dl = [new Float32Array(this.L), new Float32Array(this.L)];
    this.dlIdx = 0;

    // Monotonic deque for sliding minimum
    const cap = this.L + 2;
    this.dqVal = new Float32Array(cap);
    this.dqPos = new Float64Array(cap);
    this.dqHead = 0; this.dqTail = 0; this.dqCap = cap;
    this.n = 0;

    this.relState = 1;

    // Box filter
    this.box = new Float32Array(this.L).fill(1);
    this.boxIdx = 0;
    this.boxSum = this.L;

    // Metering
    this.minGain = 1;
    this.reportEvery = Math.round(sampleRate / 30);
    this.reportCount = 0;
    this.recalcCount = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.thresholdDb === 'number') this.thr = Math.pow(10, Math.min(0, d.thresholdDb) / 20);
      if (typeof d.releaseSec === 'number') this._setRelease(d.releaseSec);
      if (typeof d.on === 'boolean') this.on = d.on;
    };
  }

  _setRelease(sec) {
    const s = Math.max(0.005, sec);
    this.relCoef = 1 - Math.exp(-1 / (s * sampleRate));
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const frames = output[0].length;
    const inL = (input && input[0]) ? input[0] : null;
    const inR = (input && input[1]) ? input[1] : inL;
    const outL = output[0];
    const outR = output[1] || null;
    const L = this.L;
    const thr = this.thr;

    for (let i = 0; i < frames; i++) {
      const xl = inL ? inL[i] : 0;
      const xr = inR ? inR[i] : 0;

      // 1. Required gain
      const pk = Math.max(Math.abs(xl), Math.abs(xr));
      const req = (this.on && pk > thr) ? thr / pk : 1;

      // 2. Sliding min (window L)
      const n = this.n++;
      while (this.dqTail !== this.dqHead) {
        const last = (this.dqTail - 1 + this.dqCap) % this.dqCap;
        if (this.dqVal[last] >= req) this.dqTail = last; else break;
      }
      this.dqVal[this.dqTail] = req;
      this.dqPos[this.dqTail] = n;
      this.dqTail = (this.dqTail + 1) % this.dqCap;
      while (this.dqPos[this.dqHead] <= n - L) this.dqHead = (this.dqHead + 1) % this.dqCap;
      const hold = this.dqVal[this.dqHead];

      // 3. Release (instant attack, smooth release)
      if (hold < this.relState) this.relState = hold;
      else this.relState += (hold - this.relState) * this.relCoef;

      // 4. Box filter
      this.boxSum += this.relState - this.box[this.boxIdx];
      this.box[this.boxIdx] = this.relState;
      this.boxIdx = (this.boxIdx + 1) % L;
      let g = this.boxSum / L;
      if (g > 1) g = 1;

      // 5. Delay & apply
      const dL = this.dl[0], dR = this.dl[1];
      const idx = this.dlIdx;
      const yl = dL[idx] * g;
      const yr = dR[idx] * g;
      dL[idx] = xl; dR[idx] = xr;
      this.dlIdx = (idx + 1) % L;

      // Safety clamp (only numeric edge cases)
      const c = this.on ? thr : 1;
      outL[i] = yl > c ? c : (yl < -c ? -c : yl);
      if (outR) outR[i] = yr > c ? c : (yr < -c ? -c : yr);

      if (g < this.minGain) this.minGain = g;
    }

    // Periodically recompute box sum to avoid float drift
    if (++this.recalcCount >= 375) {
      this.recalcCount = 0;
      let s = 0; for (let k = 0; k < L; k++) s += this.box[k];
      this.boxSum = s;
    }

    this.reportCount += frames;
    if (this.reportCount >= this.reportEvery) {
      this.reportCount = 0;
      this.port.postMessage({ gr: this.minGain });
      this.minGain = 1;
    }
    return true;
  }
}

registerProcessor('sn-limiter', SNLimiterProcessor);
