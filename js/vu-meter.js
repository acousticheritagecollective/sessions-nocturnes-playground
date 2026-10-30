/* ═══════════════════════════════════════════
   VU METER — Output peak meter with clip detection
   Lee del SN.AudioEngine.masterAnalyser
   Render: <canvas id="vu-meter"></canvas>
   ═══════════════════════════════════════════ */

SN.VuMeter = {
  canvas: null,
  ctx2d: null,
  buffer: null,
  _peakHold: 0,
  _peakHoldFrames: 0,
  _clipLatchUntil: 0,
  _running: false,

  init() {
    this.canvas = document.getElementById('vu-meter');
    if (!this.canvas) {
      console.warn('[VuMeter] No #vu-meter canvas found in HTML — meter disabled');
      return;
    }
    if (!SN.AudioEngine.masterAnalyser) {
      console.warn('[VuMeter] No masterAnalyser on AudioEngine');
      return;
    }
    this.ctx2d = this.canvas.getContext('2d');
    this.buffer = new Float32Array(SN.AudioEngine.masterAnalyser.fftSize);
    this._running = true;
    this._loop();
    console.log('[VuMeter] Init');
  },

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());

    const analyser = SN.AudioEngine.masterAnalyser;
    analyser.getFloatTimeDomainData(this.buffer);

    // Peak absoluto en este frame
    let peak = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const v = Math.abs(this.buffer[i]);
      if (v > peak) peak = v;
    }

    // Peak hold (cae lentamente)
    if (peak >= this._peakHold) {
      this._peakHold = peak;
      this._peakHoldFrames = 30; // sostener ~0.5s a 60fps
    } else if (this._peakHoldFrames > 0) {
      this._peakHoldFrames--;
    } else {
      this._peakHold = Math.max(peak, this._peakHold * 0.92); // decay
    }

    // Clip latch — si supera 0.99, fija indicador clip ~1s
    const now = performance.now();
    if (peak >= 0.99) {
      this._clipLatchUntil = now + 1000;
    }
    const clipping = now < this._clipLatchUntil;

    this._draw(peak, this._peakHold, clipping);
  },

  _draw(peak, peakHold, clipping) {
    const c = this.ctx2d;
    // V2.3: HiDPI backing store + vertical orientation when the canvas is
    // taller than wide (same scale, colours, marks and clip as before).
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || this.canvas.width;
    const cssH = this.canvas.clientHeight || this.canvas.height;
    const bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) { this.canvas.width = bw; this.canvas.height = bh; }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;
    const vertical = h > w;
    const len = vertical ? h : w;

    // Fondo
    c.fillStyle = '#111';
    c.fillRect(0, 0, w, h);

    // Barra principal — escala lineal de amplitud
    // Mapeo: 0 → 0px, 0.5 → mitad, 1 → len. -6dB ≈ 0.5, -3dB ≈ 0.707
    const barL = Math.min(peak, 1) * len;

    // Gradiente verde → amarillo → rojo
    const grad = vertical ? c.createLinearGradient(0, h, 0, 0) : c.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0,    '#00ff66');
    grad.addColorStop(0.6,  '#88ff00');  // ~-4dB
    grad.addColorStop(0.78, '#ffcc00');  // ~-2dB
    grad.addColorStop(0.92, '#ff6600');  // ~-0.7dB
    grad.addColorStop(1,    '#ff0033');  // 0dBFS
    c.fillStyle = grad;
    if (vertical) c.fillRect(2, h - barL, w - 4, barL);
    else c.fillRect(0, 2, barL, h - 4);

    // Peak hold marker
    const holdP = Math.min(peakHold, 1) * len;
    c.fillStyle = '#ffffff';
    if (vertical) c.fillRect(1, h - holdP - 1, w - 2, 2);
    else c.fillRect(holdP - 1, 1, 2, h - 2);

    // Marcas de referencia (-12, -6, -3 dBFS)
    const marks = [
      { val: 0.25, label: '-12' },  // -12dB ≈ 0.25
      { val: 0.5,  label: '-6'  },  // -6dB ≈ 0.5
      { val: 0.707, label: '-3' },  // -3dB ≈ 0.707
    ];
    c.fillStyle = 'rgba(255,255,255,0.35)';
    marks.forEach(m => {
      const p = m.val * len;
      if (vertical) c.fillRect(0, h - p, w, 1);
      else c.fillRect(p, 0, 1, h);
    });

    // Clip indicator — recuadro rojo que parpadea
    if (clipping) {
      c.strokeStyle = '#ff0033';
      c.lineWidth = 2;
      c.strokeRect(1, 1, w - 2, h - 2);
    }
  }
};
