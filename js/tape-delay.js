/* ═══════════════════════════════════════════
   TAPE DELAY — Parallel FX, output level only
   sendBus → delay → wetGain(1.0) → outputGain → fxReturnBus
   ═══════════════════════════════════════════ */

SN.TapeDelay = {
  delayNode: null,
  feedbackGain: null,
  tapeFilter: null,
  wetGain: null,        // Pinned al 100% — sin dry/wet
  outputGain: null,     // Nivel de retorno al master, inicia en 0
  _outputNode: null,
  _division: 'free',
  _freeTimeMs: 250,

  init() {
    const ctx = SN.AudioEngine.ctx;

    this.delayNode = ctx.createDelay(2.0);
    this.delayNode.delayTime.value = 0.25;

    this.feedbackGain = ctx.createGain();
    this.feedbackGain.gain.value = 0.3;

    this.tapeFilter = ctx.createBiquadFilter();
    this.tapeFilter.type = 'lowpass';
    this.tapeFilter.frequency.value = 3500;
    this.tapeFilter.Q.value = 0.5;

    // Wet siempre 100%
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 1;

    // Output del módulo, parte en 0
    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = 0;

    this._outputNode = this.outputGain; // alias por compatibilidad

    // Routing PARALELO:
    // sendBus → delayNode → wetGain → outputGain → fxReturnBus
    // delayNode → tapeFilter → feedbackGain → delayNode (feedback)
    SN.AudioEngine.sendBus.connect(this.delayNode);

    this.delayNode.connect(this.wetGain);
    this.wetGain.connect(this.outputGain);
    this.outputGain.connect(SN.AudioEngine.fxReturnBus);

    // Feedback loop
    this.delayNode.connect(this.tapeFilter);
    this.tapeFilter.connect(this.feedbackGain);
    this.feedbackGain.connect(this.delayNode);

    console.log('[TapeDelay] Init (parallel, output @ 0)');
  },

  setOutput(val) {
    this.outputGain.gain.setTargetAtTime(val, SN.AudioEngine.ctx.currentTime, 0.02);
  },

  setFeedback(val) {
    this.feedbackGain.gain.setTargetAtTime(Math.min(val, 0.95), SN.AudioEngine.ctx.currentTime, 0.02);
  },

  setTimeMs(ms) {
    this.delayNode.delayTime.setTargetAtTime(SN.Utils.clamp(ms, 10, 2000) / 1000, SN.AudioEngine.ctx.currentTime, 0.03);
  },

  setDivision(division) {
    this._division = division;
    if (division === 'free') this.setTimeMs(this._freeTimeMs);
    else this.syncToBPM();
  },

  syncToBPM() {
    if (this._division === 'free') return;
    const ms = SN.Utils.delayTimeForDivision(this._division, SN.Transport.bpm);
    if (ms !== null) {
      this.setTimeMs(ms);
      const d = document.getElementById('delay-time-val');
      if (d) d.textContent = Math.round(ms) + ' ms';
    }
  },

  onBPMChange() { this.syncToBPM(); }
};
