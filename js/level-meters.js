/* ═══════════════════════════════════════════
   LEVEL METERS — per-channel & FX peak meters (V2.4)
   Passive AnalyserNode taps (they don't touch the signal):
     · channels: post-fader / post-mute (what the channel sends out)
     · FX: module output (after OUT knob)
   Same look as the master meter: green → red, peak hold, clip box.
   Vertical when the canvas is taller than wide, horizontal otherwise.
   Taps are resolved through getters, so they survive an audio rebuild.
   ═══════════════════════════════════════════ */

SN.LevelMeters = {
  _meters: [],
  _running: false,
  _buf: null,

  add(canvas, getNode) {
    if (!canvas || typeof getNode !== 'function') return;
    this._meters.push({ canvas, getNode, node: null, analyser: null, peakHold: 0, holdFrames: 0, clipUntil: 0 });
  },

  init() {
    const A = SN.App;
    const byStrip = (id) => document.querySelector('#' + id + ' .ch-meter');

    // Channels (post-fader, post-mute)
    if (A.trackDecks[0]) this.add(byStrip('ch08a'), () => A.trackDecks[0].muteGain);
    if (A.trackDecks[1]) this.add(byStrip('ch08b'), () => A.trackDecks[1].muteGain);
    this.add(byStrip('ch05'), () => SN.Sequencer.muteGain);
    (SN.ExtInput.channels || []).forEach((ch) => {
      this.add(ch.el.querySelector('.ch-meter'), () => ch.muteGain);
    });

    // FX outputs
    this.add(document.getElementById('delay-meter'), () => SN.TapeDelay.outputGain);
    this.add(document.getElementById('reverb-meter'), () => SN.Reverb.outputGain);
    this.add(document.getElementById('dist-meter'), () => SN.Distortion.outputGain);
    // AUX bus (what reaches the aux output)
    this.add(document.getElementById('aux-meter'), () => SN.Aux.bus);

    this._buf = new Float32Array(512);
    if (!this._running) { this._running = true; this._loop(); }
    console.log('[LevelMeters] Init —', this._meters.length, 'meters');
  },

  _ensureTap(m) {
    const node = m.getNode();
    if (!node) return false;
    if (node !== m.node || !m.analyser || m.analyser.context !== node.context) {
      if (m.analyser && m.node) { try { m.node.disconnect(m.analyser); } catch (e) {} }
      const an = node.context.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0;
      node.connect(an);
      m.analyser = an;
      m.node = node;
    }
    return true;
  },

  _loop() {
    requestAnimationFrame(() => this._loop());
    const now = performance.now();
    for (let k = 0; k < this._meters.length; k++) {
      const m = this._meters[k];
      if (!m.canvas.isConnected || !this._ensureTap(m)) continue;
      m.analyser.getFloatTimeDomainData(this._buf);
      let peak = 0;
      for (let i = 0; i < this._buf.length; i++) {
        const v = Math.abs(this._buf[i]);
        if (v > peak) peak = v;
      }
      if (peak >= m.peakHold) { m.peakHold = peak; m.holdFrames = 30; }
      else if (m.holdFrames > 0) m.holdFrames--;
      else m.peakHold = Math.max(peak, m.peakHold * 0.92);
      if (peak >= 0.99) m.clipUntil = now + 1000;
      this._draw(m.canvas, peak, m.peakHold, now < m.clipUntil);
    }
  },

  _draw(canvas, peak, peakHold, clipping) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (!w || !h) return;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vertical = h > w;
    const len = vertical ? h : w;

    c.fillStyle = '#111';
    c.fillRect(0, 0, w, h);

    const grad = vertical ? c.createLinearGradient(0, h, 0, 0) : c.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0,    '#00ff66');
    grad.addColorStop(0.6,  '#88ff00');
    grad.addColorStop(0.78, '#ffcc00');
    grad.addColorStop(0.92, '#ff6600');
    grad.addColorStop(1,    '#ff0033');
    c.fillStyle = grad;
    const barL = Math.min(peak, 1) * len;
    if (vertical) c.fillRect(1, h - barL, w - 2, barL);
    else c.fillRect(0, 1, barL, h - 2);

    const holdP = Math.min(peakHold, 1) * len;
    if (holdP > 1) {
      c.fillStyle = '#ffffff';
      if (vertical) c.fillRect(0, h - holdP - 1, w, 2);
      else c.fillRect(holdP - 1, 0, 2, h);
    }

    // -12 / -6 / -3 dBFS marks
    c.fillStyle = 'rgba(255,255,255,0.3)';
    [0.25, 0.5, 0.707].forEach(v => {
      const p = v * len;
      if (vertical) c.fillRect(0, h - p, w, 1);
      else c.fillRect(p, 0, 1, h);
    });

    if (clipping) {
      c.strokeStyle = '#ff0033';
      c.lineWidth = 2;
      c.strokeRect(1, 1, w - 2, h - 2);
    }
  }
};
