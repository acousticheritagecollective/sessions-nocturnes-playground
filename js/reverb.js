/* ═══════════════════════════════════════════
   LONG REVERB — Parallel FX, output level only
   8-tap FDN
   reverbSendBus → FDN → wetGain(1.0) → outputGain → fxReturnBus
   ═══════════════════════════════════════════ */

SN.Reverb = {
  wetGain: null,        // Pinned al 100%
  outputGain: null,     // Nivel de retorno, inicia en 0
  dampFilter: null,
  _outputNode: null,
  _delays: [],
  _feedbacks: [],
  _fbFilters: [],

  init() {
    const ctx = SN.AudioEngine.ctx;

    // Reset defensivo — soporta re-init
    this._delays = [];
    this._feedbacks = [];
    this._fbFilters = [];

    this.preDelay = ctx.createDelay(0.2);
    this.preDelay.delayTime.value = 0.025;

    this.diffuser1 = ctx.createBiquadFilter();
    this.diffuser1.type = 'allpass'; this.diffuser1.frequency.value = 800; this.diffuser1.Q.value = 4;
    this.diffuser2 = ctx.createBiquadFilter();
    this.diffuser2.type = 'allpass'; this.diffuser2.frequency.value = 2200; this.diffuser2.Q.value = 3;

    this.dampFilter = ctx.createBiquadFilter();
    this.dampFilter.type = 'lowpass'; this.dampFilter.frequency.value = 4000; this.dampFilter.Q.value = 0.3;

    // Wet siempre 100%
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 1;

    // Output del módulo, parte en 0
    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = 0;

    this._outputNode = this.outputGain; // alias compat

    this.mixNode = ctx.createGain();
    this.mixNode.gain.value = 0.15;

    const delayTimes = [0.031, 0.043, 0.057, 0.069, 0.079, 0.091, 0.101, 0.113];
    delayTimes.forEach((time, i) => {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = time;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.82;
      const fbFilter = ctx.createBiquadFilter();
      fbFilter.type = 'lowpass'; fbFilter.frequency.value = 5000 - (i * 350); fbFilter.Q.value = 0.3;
      const allpass = ctx.createBiquadFilter();
      allpass.type = 'allpass'; allpass.frequency.value = 500 + i * 400; allpass.Q.value = 1.5;

      delay.connect(allpass);
      allpass.connect(fbFilter);
      fbFilter.connect(feedback);
      feedback.connect(delay);
      allpass.connect(this.mixNode);

      this._delays.push(delay);
      this._feedbacks.push(feedback);
      this._fbFilters.push(fbFilter);
    });

    // Wet path: reverbSendBus → preDelay → diffusers → FDN → mix → damp → wetGain → outputGain → fxReturnBus
    SN.AudioEngine.reverbSendBus.connect(this.preDelay);
    this.preDelay.connect(this.diffuser1);
    this.diffuser1.connect(this.diffuser2);
    this._delays.forEach(d => this.diffuser2.connect(d));
    this.mixNode.connect(this.dampFilter);
    this.dampFilter.connect(this.wetGain);
    this.wetGain.connect(this.outputGain);
    this.outputGain.connect(SN.AudioEngine.fxReturnBus);

    console.log('[Reverb] Init (parallel, output @ 0)');
  },

  setOutput(val) {
    this.outputGain.gain.setTargetAtTime(val, SN.AudioEngine.ctx.currentTime, 0.02);
  },

  setDecay(seconds) {
    const fb = 0.4 + (Math.min(seconds, 10) / 10) * 0.52;
    const t = SN.AudioEngine.ctx.currentTime;
    this._feedbacks.forEach(g => g.gain.setTargetAtTime(fb, t, 0.05));
  },

  setDamp(freq) {
    this.dampFilter.frequency.setTargetAtTime(freq, SN.AudioEngine.ctx.currentTime, 0.02);
  }
};
