/* ═══════════════════════════════════════════
   DISTORTION — Parallel FX, output level only
   distSendBus → waveshaper → wetGain(1.0) → outputGain → fxReturnBus
   ═══════════════════════════════════════════ */

SN.Distortion = {
  waveshaper: null,
  toneFilter: null,
  wetGain: null,        // Pinned al 100%
  outputGain: null,     // Nivel de retorno, inicia en 0
  inputGain: null,
  _drive: 8,

  init() {
    const ctx = SN.AudioEngine.ctx;

    this.inputGain = ctx.createGain();
    this.inputGain.gain.value = 1;

    this.waveshaper = ctx.createWaveShaper();
    this.waveshaper.oversample = '4x';
    this._setCurve(this._drive);

    this.toneFilter = ctx.createBiquadFilter();
    this.toneFilter.type = 'lowpass'; this.toneFilter.frequency.value = 3000; this.toneFilter.Q.value = 0.7;

    // Wet siempre 100%
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 1;

    // Output del módulo, parte en 0
    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = 0;

    // distSendBus → inputGain → waveshaper → toneFilter → wetGain → outputGain → fxReturnBus
    SN.AudioEngine.distSendBus.connect(this.inputGain);
    this.inputGain.connect(this.waveshaper);
    this.waveshaper.connect(this.toneFilter);
    this.toneFilter.connect(this.wetGain);
    this.wetGain.connect(this.outputGain);
    this.outputGain.connect(SN.AudioEngine.fxReturnBus);

    console.log('[Distortion] Init (parallel, output @ 0)');
  },

  _setCurve(drive) {
    const samples = 44100;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((1 + drive) * x) / (1 + drive * Math.abs(x));
    }
    this.waveshaper.curve = curve;
  },

  setOutput(val) {
    this.outputGain.gain.setTargetAtTime(val, SN.AudioEngine.ctx.currentTime, 0.02);
  },

  setDrive(val) { this._drive = val; this._setCurve(val); },

  setTone(freq) {
    this.toneFilter.frequency.setTargetAtTime(freq, SN.AudioEngine.ctx.currentTime, 0.02);
  }
};
