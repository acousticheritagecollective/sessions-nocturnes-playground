/* ═══════════════════════════════════════════
   SNARE SEQUENCER — CH05b
   32-step trigger, HPF + MID peak + LPF EQ
   Random always keeps backbeats ON
   ═══════════════════════════════════════════ */

SN.SnareSeq = {
  steps: new Array(32).fill(false),
  snareBuffer: null,
  snarePitch: 0,
  knobs: {},

  // Audio nodes
  gainNode: null,
  hpf: null,
  midEq: null,
  lpf: null,
  faderGain: null,
  sendGain: null,
  sendRevGain: null,
  sendDistGain: null,

  // Backbeats: steps 3,7,11,15,19,23,27,31 (0-indexed: 2,6,10,14,18,22,26,30)
  BACKBEATS: [4, 12, 20, 28],

  init() {
    const ctx = SN.AudioEngine.ctx;
    const el = document.getElementById('ch-snare');
    this.el = el;

    // HPF (replaces low EQ band)
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 80;
    this.hpf.Q.value = 0.7;

    // Mid peaking EQ
    this.midEq = ctx.createBiquadFilter();
    this.midEq.type = 'peaking';
    this.midEq.frequency.value = 1000;
    this.midEq.Q.value = 1;
    this.midEq.gain.value = 0;

    // LPF (replaces high EQ band)
    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 12000;
    this.lpf.Q.value = 0.7;

    // Output gain (pre-fader)
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 1;

    // Fader
    this.faderGain = ctx.createGain();
    this.faderGain.gain.value = 0.8;

    // Sends
    this.sendGain = ctx.createGain();
    this.sendGain.gain.value = 0;
    this.sendRevGain = ctx.createGain();
    this.sendRevGain.gain.value = 0;
    this.sendDistGain = ctx.createGain();
    this.sendDistGain.gain.value = 0;

    // Chain: source → gainNode → HPF → MID → LPF → faderGain → master
    this.gainNode.connect(this.hpf);
    this.hpf.connect(this.midEq);
    this.midEq.connect(this.lpf);
    this.lpf.connect(this.faderGain);
    this.faderGain.connect(SN.AudioEngine.preFilterGain);

    // Sends post-fader
    this.faderGain.connect(this.sendGain);
    this.sendGain.connect(SN.AudioEngine.sendBus);
    this.faderGain.connect(this.sendRevGain);
    this.sendRevGain.connect(SN.AudioEngine.reverbSendBus);
    this.faderGain.connect(this.sendDistGain);
    this.sendDistGain.connect(SN.AudioEngine.distSendBus);

    this._initUI();
    this._buildSteps();
    this._populateSampleSelector();
    this._initRandomBtn();

    SN.Transport.onStep((step, time) => this._onStep(step, time));

    console.log('[SnareSeq] Initialized (32 steps)');
  },

  _initUI() {
    if (!this.el) return;

    // Knobs
    this.el.querySelectorAll('.knob-wrap').forEach(knobEl => {
      const knob = new SN.Knob(knobEl, (param, value) => this._onKnobChange(param, value));
      this.knobs[knobEl.dataset.param] = knob;
    });

    // Fader
    const fader = document.getElementById('snare-fader');
    if (fader) {
      fader.addEventListener('input', () => {
        this.faderGain.gain.setTargetAtTime(parseFloat(fader.value), SN.AudioEngine.ctx.currentTime, 0.02);
      });
    }
  },

  _onKnobChange(param, value) {
    const t = SN.AudioEngine.ctx.currentTime;
    switch (param) {
      case 'snarePitch': this.snarePitch = Math.round(value); break;
      case 'snareHpf': this.hpf.frequency.setTargetAtTime(value, t, 0.02); break;
      case 'snareMid': this.midEq.gain.setTargetAtTime(value, t, 0.02); break;
      case 'snareLpf': this.lpf.frequency.setTargetAtTime(value, t, 0.02); break;
      case 'snareSendDly': this.sendGain.gain.setTargetAtTime(value, t, 0.02); break;
      case 'snareSendRev': this.sendRevGain.gain.setTargetAtTime(value, t, 0.02); break;
      case 'snareSendDist': this.sendDistGain.gain.setTargetAtTime(value, t, 0.02); break;
    }
  },

  _buildSteps() {
    const container = document.getElementById('snare-seq-steps');
    if (!container) return;
    container.innerHTML = '';

    for (let i = 0; i < 32; i++) {
      const btn = document.createElement('button');
      btn.className = 'seq-step';
      btn.dataset.step = i;
      btn.textContent = i + 1;

      if (i % 4 === 0) btn.classList.add('beat-marker');
      if (i > 0 && i % 8 === 0) btn.classList.add('bar-start');

      btn.addEventListener('click', () => this._toggleStep(i));
      container.appendChild(btn);
    }
  },

  _toggleStep(index) {
    this.steps[index] = !this.steps[index];
    const container = document.getElementById('snare-seq-steps');
    const btn = container?.children[index];
    if (btn) btn.classList.toggle('on', this.steps[index]);
  },

  _populateSampleSelector() {
    const select = document.getElementById('snare-sample-select');
    if (!select) return;

    select.innerHTML = '<option value="">— Select Snare —</option>';
    const samples = SN.Utils.sampleList('snares-samples');
    samples.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.url;
      opt.textContent = s.name;
      select.appendChild(opt);
    });

    select.addEventListener('change', async () => {
      if (select.value) {
        this.snareBuffer = await SN.AudioEngine.loadSample(select.value);
        if (this.snareBuffer) console.log('[SnareSeq] Snare loaded: ' + select.value);
      }
    });
  },

  _onStep(step, time) {
    this._highlightStep(step);
    if (step >= 0 && step < 32 && this.steps[step] && this.snareBuffer) {
      const ctx = SN.AudioEngine.ctx;
      const source = ctx.createBufferSource();
      source.buffer = this.snareBuffer;
      if (this.snarePitch !== 0) {
        source.playbackRate.value = Math.pow(2, this.snarePitch / 12);
      }
      source.connect(this.gainNode);
      source.start(time);
    }
  },

  _highlightStep(step) {
    const container = document.getElementById('snare-seq-steps');
    if (!container) return;
    container.querySelectorAll('.seq-step').forEach(btn => btn.classList.remove('current'));
    if (step >= 0 && step < 32) {
      const btn = container.children[step];
      if (btn) btn.classList.add('current');
    }
  },

  _initRandomBtn() {
    const btn = document.getElementById('snare-random-btn');
    if (btn) {
      btn.addEventListener('click', () => this.randomize());
    }
  },

  randomize() {
    this.steps.fill(false);
    // Always keep backbeats ON: 3,7,11,15,19,23,27,31 (indices 2,6,10,14,18,22,26,30)
    this.BACKBEATS.forEach(i => this.steps[i] = true);
    // Add 0-8 random extras on non-backbeat steps
    const extras = Math.floor(Math.random() * 9);
    const available = [];
    for (let i = 0; i < 32; i++) {
      if (!this.BACKBEATS.includes(i)) available.push(i);
    }
    for (let n = 0; n < extras && available.length > 0; n++) {
      const pick = Math.floor(Math.random() * available.length);
      this.steps[available[pick]] = true;
      available.splice(pick, 1);
    }
    // Update UI
    const container = document.getElementById('snare-seq-steps');
    if (container) {
      for (let i = 0; i < 32; i++) {
        container.children[i]?.classList.toggle('on', this.steps[i]);
      }
    }
  },

  setPitch(semitones) {
    this.snarePitch = Math.round(semitones);
  },

  setGain(val) {
    this.faderGain.gain.setTargetAtTime(val, SN.AudioEngine.ctx.currentTime, 0.02);
  }
};
