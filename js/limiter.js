/* ═══════════════════════════════════════════
   LIMITER — Output peak limiter (V2)
   masterGain → Limiter → destination
   AudioWorklet look-ahead brickwall (js/limiter-processor.js)
   Fallback: DynamicsCompressor (ratio 20, fast attack) if worklet fails.
   UI: THRESH (dBFS ceiling), REL (ms), ON/OFF, GR meter in dB.
   ═══════════════════════════════════════════ */

SN.Limiter = {
  input: null,
  output: null,
  node: null,          // AudioWorkletNode or DynamicsCompressorNode
  mode: null,          // 'worklet' | 'compressor'
  on: true,
  thresholdDb: -1,
  releaseMs: 150,
  _gr: 0,              // current gain reduction in dB (<= 0)
  _grHold: 0,
  _grHoldUntil: 0,
  _uiReady: false,

  async init(ctx) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.node = null;

    try {
      if (!ctx.audioWorklet) throw new Error('no audioWorklet');
      await ctx.audioWorklet.addModule('js/limiter-processor.js');
      this.node = new AudioWorkletNode(ctx, 'sn-limiter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers'
      });
      this.node.port.onmessage = (e) => {
        if (e.data && typeof e.data.gr === 'number') {
          const g = Math.max(1e-6, e.data.gr);
          this._gr = 20 * Math.log10(g);
        }
      };
      this.mode = 'worklet';
    } catch (err) {
      console.warn('[Limiter] Worklet unavailable, using DynamicsCompressor fallback:', err);
      this.node = ctx.createDynamicsCompressor();
      this.node.knee.value = 0;
      this.node.ratio.value = 20;
      this.node.attack.value = 0.001;
      this.mode = 'compressor';
    }

    this.input.connect(this.node);
    this.node.connect(this.output);
    this._apply();
    console.log('[Limiter] Init (' + this.mode + ')');
  },

  _apply() {
    if (!this.node) return;
    if (this.mode === 'worklet') {
      this.node.port.postMessage({ thresholdDb: this.thresholdDb, releaseSec: this.releaseMs / 1000, on: this.on });
    } else {
      const t = this.node.context.currentTime;
      this.node.threshold.setTargetAtTime(this.on ? this.thresholdDb : 0, t, 0.01);
      this.node.ratio.setTargetAtTime(this.on ? 20 : 1, t, 0.01);
      this.node.release.setTargetAtTime(this.releaseMs / 1000, t, 0.01);
    }
  },

  setThreshold(db) { this.thresholdDb = Math.min(-0.1, db); this._apply(); },
  setRelease(ms)   { this.releaseMs = ms; this._apply(); },
  setOn(on)        { this.on = !!on; this._apply(); },

  /* ─── UI ─── */
  initUI() {
    const thrEl = document.getElementById('lim-thresh-knob');
    const relEl = document.getElementById('lim-release-knob');
    if (thrEl) SN.App.knobs.limThresh = new SN.Knob(thrEl, (p, v) => this.setThreshold(v));
    if (relEl) SN.App.knobs.limRelease = new SN.Knob(relEl, (p, v) => this.setRelease(v));

    const btn = document.getElementById('lim-toggle');
    if (btn) {
      btn.classList.toggle('active', this.on);
      btn.textContent = this.on ? 'ON' : 'OFF';
      btn.addEventListener('click', () => {
        this.setOn(!this.on);
        btn.classList.toggle('active', this.on);
        btn.textContent = this.on ? 'ON' : 'OFF';
      });
    }

    this._barEl = document.getElementById('lim-gr-fill');
    this._holdEl = document.getElementById('lim-gr-hold');
    this._valEl = document.getElementById('lim-gr-val');
    this._modeEl = document.getElementById('lim-mode');
    if (this._modeEl && this.mode === 'compressor') this._modeEl.textContent = 'COMP';
    this._uiReady = true;
    this._loop();
  },

  _loop() {
    requestAnimationFrame(() => this._loop());
    let gr = 0;
    if (this.mode === 'compressor' && this.node) gr = this.node.reduction || 0;
    else gr = this._gr;
    if (!this.on) gr = 0;

    const now = performance.now();
    if (gr <= this._grHold || now > this._grHoldUntil) {
      this._grHold = gr;
      this._grHoldUntil = now + 1200;
    }

    const RANGE = 12; // meter shows 0 … -12 dB
    const pct = Math.min(100, (-gr / RANGE) * 100);
    const holdPct = Math.min(100, (-this._grHold / RANGE) * 100);
    if (this._barEl) this._barEl.style.width = pct.toFixed(1) + '%';
    if (this._holdEl) this._holdEl.style.left = holdPct.toFixed(1) + '%';
    if (this._holdEl) this._holdEl.style.opacity = this._grHold < -0.05 ? '1' : '0';
    if (this._valEl) {
      const shown = this._grHold;
      this._valEl.textContent = (shown > -0.05 ? '0.0' : shown.toFixed(1)) + ' dB';
      this._valEl.classList.toggle('active', shown < -0.05);
    }
  }
};
