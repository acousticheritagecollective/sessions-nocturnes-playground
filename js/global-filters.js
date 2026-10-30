/* ═══════════════════════════════════════════
   GLOBAL FILTERS — HPF & LPF
   Inserted between preFilterGain and masterGain
   ═══════════════════════════════════════════ */

SN.GlobalFilters = {
  hpf: null,
  lpf: null,
  hpfActive: false,
  lpfActive: false,

  // Frecuencia "deseada" recordada aunque el filtro esté bypaseado,
  // para poder restaurarla al reactivar.
  _hpfFreq: 20,
  _lpfFreq: 20000,

  init() {
    const ctx = SN.AudioEngine.ctx;

    // Create filters
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 20;
    this.hpf.Q.value = 0.7;

    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 20000;
    this.lpf.Q.value = 0.7;

    this._hpfFreq = 20;
    this._lpfFreq = 20000;

    // Re-route: preFilterGain → HPF → LPF → masterGain
    SN.AudioEngine.preFilterGain.disconnect();
    SN.AudioEngine.preFilterGain.connect(this.hpf);
    this.hpf.connect(this.lpf);
    this.lpf.connect(SN.AudioEngine.masterGain);

    console.log('[GlobalFilters] Initialized');
  },

  setHPFActive(active) {
    this.hpfActive = active;
    const t = SN.AudioEngine.ctx.currentTime;
    if (active) {
      // Restaurar la frecuencia deseada al reactivar
      this.hpf.frequency.setTargetAtTime(this._hpfFreq, t, 0.02);
    } else {
      // Bypass: abrir completamente
      this.hpf.frequency.setTargetAtTime(20, t, 0.02);
    }
  },

  setLPFActive(active) {
    this.lpfActive = active;
    const t = SN.AudioEngine.ctx.currentTime;
    if (active) {
      this.lpf.frequency.setTargetAtTime(this._lpfFreq, t, 0.02);
    } else {
      this.lpf.frequency.setTargetAtTime(20000, t, 0.02);
    }
  },

  setHPFFreq(hz) {
    // Guardar siempre el valor, aunque el filtro esté off
    this._hpfFreq = SN.Utils.clamp(hz, 20, 700);
    if (!this.hpfActive) return;
    const t = SN.AudioEngine.ctx.currentTime;
    this.hpf.frequency.setTargetAtTime(this._hpfFreq, t, 0.02);
  },

  setLPFFreq(hz) {
    this._lpfFreq = SN.Utils.clamp(hz, 200, 20000);
    if (!this.lpfActive) return;
    const t = SN.AudioEngine.ctx.currentTime;
    this.lpf.frequency.setTargetAtTime(this._lpfFreq, t, 0.02);
  }
};