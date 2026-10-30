/* ═══════════════════════════════════════════
   SYNTH BASS — CH07
   Oscillator + Filter + ADSR + Pitched Step Seq
   Each step has: gate on/off + pitch offset ±12
   Oscilloscope visualization
   ═══════════════════════════════════════════ */

SN.SynthBass = {
  el: null,
  knobs: {},

  // Oscillator params
  waveType: 'sawtooth',
  baseNote: 36, // MIDI note (C2)
  cutoff: 800,
  resonance: 2,

  // ADSR
  attack: 0.001,
  decay: 0.15,
  sustain: 0.6,
  release: 0.2,

  // Audio nodes (persistent chain)
  filter: null,
  faderGain: null,
  sendGain: null,
  sendRevGain: null,
  sendDistGain: null,
  analyser: null,

  // Step sequencer: 32 steps (half speed: 1 synth step = 2 transport steps)
  steps: [],
  NUM_STEPS: 32,
  seqActive: false,
  _activeVoices: [],

  // Scale intervals within ±12 semitones (0 = root)
  MAJOR_PITCHES: [-12, -10, -8, -7, -5, -3, -1, 0, 2, 4, 5, 7, 9, 11, 12],
  MINOR_PITCHES: [-12, -10, -9, -7, -5, -4, -2, 0, 2, 3, 5, 7, 8, 10, 12],

  // Scope
  _scopeRAF: null,

  init() {
    const ctx = SN.AudioEngine.ctx;
    this.el = document.getElementById('ch07-synth');
    if (!this.el) return;

    // Init steps
    for (let i = 0; i < this.NUM_STEPS; i++) {
      this.steps.push({ active: false, pitch: 0 });
    }

    // Filter
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = this.cutoff;
    this.filter.Q.value = this.resonance;

    // Pre-fader trim (-6dB to avoid overpowering the mix)
    this.trimGain = ctx.createGain();
    this.trimGain.gain.value = 0.3; // -6dB

    // Fader
    this.faderGain = ctx.createGain();
    this.faderGain.gain.value = 0.8;

    // Analyser for scope
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;

    // Sends
    this.sendGain = ctx.createGain();
    this.sendGain.gain.value = 0;
    this.sendRevGain = ctx.createGain();
    this.sendRevGain.gain.value = 0;
    this.sendDistGain = ctx.createGain();
    this.sendDistGain.gain.value = 0;

    // Chain: filter → analyser → trimGain → faderGain → master
    this.filter.connect(this.analyser);
    this.analyser.connect(this.trimGain);
    this.trimGain.connect(this.faderGain);
    this.faderGain.connect(SN.AudioEngine.preFilterGain);

    // Sends post-fader
    this.faderGain.connect(this.sendGain);
    this.sendGain.connect(SN.AudioEngine.sendBus);
    this.faderGain.connect(this.sendRevGain);
    this.sendRevGain.connect(SN.AudioEngine.reverbSendBus);
    this.faderGain.connect(this.sendDistGain);
    this.sendDistGain.connect(SN.AudioEngine.distSendBus);

    // UI
    this._initUI();

    // Transport
    SN.Transport.onStep((step, time) => this._onStep(step, time));

    // Start scope
    this._startScope();

    console.log('[SynthBass] Initialized');
  },

  /* ─── MIDI NOTE → FREQUENCY ─── */

  _midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  },

  /* ─── TRIGGER A NOTE ─── */

  _triggerNote(time, midiNote) {
    const ctx = SN.AudioEngine.ctx;
    const freq = this._midiToFreq(midiNote);

    // Create oscillator
    const osc = ctx.createOscillator();
    osc.type = this.waveType;
    osc.frequency.setValueAtTime(freq, time);

    // ADSR envelope
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    // Attack
    env.gain.linearRampToValueAtTime(1, time + this.attack);
    // Decay → Sustain
    env.gain.linearRampToValueAtTime(this.sustain, time + this.attack + this.decay);

    // Calculate step duration (synth runs at half speed = 2 sixteenths per step)
    const stepDur = SN.Utils.sixteenthDuration(SN.Transport.bpm) * 1;
    const releaseStart = time + stepDur * 0.9; // release at 80% of step
    env.gain.setValueAtTime(this.sustain, releaseStart);
    env.gain.linearRampToValueAtTime(0, releaseStart + this.release);

    // Connect: osc → env → filter (persistent chain continues from there)
    osc.connect(env);
    env.connect(this.filter);

    osc.start(time);
    osc.stop(releaseStart + this.release + 0.05);

    // Cleanup
    osc.onended = () => {
      try { osc.disconnect(); } catch (e) {}
      try { env.disconnect(); } catch (e) {}
    };
  },

  /* ─── TRANSPORT STEP ─── */

  _onStep(step, time) {
    // Half speed: synth advances every 2 transport steps
    if (step < 0) {
      this._highlightStep(-1);
      return;
    }
    if (step % 1 !== 0) return; // skip odd steps
    const synthStep = step / 1; // 0-15
    this._highlightStep(synthStep);

    if (!this.seqActive) return;
    if (synthStep >= this.NUM_STEPS) return;

    const s = this.steps[synthStep];
    if (s.active) {
      const note = this.baseNote + s.pitch;
      this._triggerNote(time, note);
    }
  },

  /* ─── OSCILLOSCOPE ─── */

  _startScope() {
    const canvas = document.getElementById('synth-scope');
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const bufLen = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufLen);

    const accent = '#ff44aa';

    const draw = () => {
      this._scopeRAF = requestAnimationFrame(draw);
      this.analyser.getByteTimeDomainData(dataArray);

      ctx2d.fillStyle = 'rgba(10,10,14,0.4)';
      ctx2d.fillRect(0, 0, w, h);

      ctx2d.lineWidth = 1.5;
      ctx2d.strokeStyle = accent;
      ctx2d.beginPath();

      const sliceWidth = w / bufLen;
      let x = 0;
      for (let i = 0; i < bufLen; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * h) / 2;
        if (i === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
        x += sliceWidth;
      }
      ctx2d.lineTo(w, h / 2);
      ctx2d.stroke();

      // Center line
      ctx2d.strokeStyle = 'rgba(255,68,170,0.15)';
      ctx2d.lineWidth = 0.5;
      ctx2d.beginPath();
      ctx2d.moveTo(0, h / 2);
      ctx2d.lineTo(w, h / 2);
      ctx2d.stroke();
    };
    draw();
  },

  /* ─── UI ─── */

  _initUI() {
    // Knobs
    this.el.querySelectorAll('.knob-wrap').forEach(knobEl => {
      const knob = new SN.Knob(knobEl, (param, value) => this._onKnobChange(param, value));
      this.knobs[knobEl.dataset.param] = knob;
    });

    // Fader
    const fader = document.getElementById('synth-fader');
    if (fader) {
      fader.addEventListener('input', () => {
        this.faderGain.gain.setTargetAtTime(parseFloat(fader.value), SN.AudioEngine.ctx.currentTime, 0.02);
      });
    }

    // Waveform buttons
    this.el.querySelectorAll('.wave-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('.wave-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.waveType = btn.dataset.wave;
      });
    });

    // Sequencer
    this._buildSeqGrid();
    const toggleBtn = this.el.querySelector('.synth-seq-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this._toggleSeq());
    }
    const rndBtn = this.el.querySelector('.synth-seq-rnd');
    if (rndBtn) {
      rndBtn.addEventListener('click', () => this._randomizeSeq());
    }
    const majBtn = this.el.querySelector('.synth-seq-major');
    if (majBtn) {
      majBtn.addEventListener('click', () => this._randomizeScale('major'));
    }
    const minBtn = this.el.querySelector('.synth-seq-minor');
    if (minBtn) {
      minBtn.addEventListener('click', () => this._randomizeScale('minor'));
    }
  },

  _onKnobChange(param, value) {
    const t = SN.AudioEngine.ctx.currentTime;
    switch (param) {
      case 'synthNote':
        this.baseNote = Math.round(value);
        break;
      case 'synthCutoff':
        this.cutoff = value;
        this.filter.frequency.setTargetAtTime(value, t, 0.02);
        break;
      case 'synthReso':
        this.resonance = value;
        this.filter.Q.setTargetAtTime(value, t, 0.02);
        break;
      case 'synthA': this.attack = value; break;
      case 'synthD': this.decay = value; break;
      case 'synthS': this.sustain = value; break;
      case 'synthR': this.release = value; break;
      case 'synthSendDly': this.sendGain.gain.setTargetAtTime(value, t, 0.02); break;
      case 'synthSendRev': this.sendRevGain.gain.setTargetAtTime(value, t, 0.02); break;
      case 'synthSendDist': this.sendDistGain.gain.setTargetAtTime(value, t, 0.02); break;
    }
  },

  /* ─── PITCHED STEP SEQUENCER ─── */

  _buildSeqGrid() {
    const grid = document.getElementById('synth-seq-grid');
    if (!grid) return;
    grid.innerHTML = '';

    for (let i = 0; i < this.NUM_STEPS; i++) {
      const cell = document.createElement('div');
      cell.className = 'synth-step';
      if (i % 2 === 0) cell.classList.add('beat');
      cell.dataset.step = i;

      const bar = document.createElement('div');
      bar.className = 'synth-step-bar';
      cell.appendChild(bar);

      const lbl = document.createElement('span');
      lbl.className = 'synth-step-pitch';
      cell.appendChild(lbl);

      cell.addEventListener('click', () => this._toggleStep(i));
      grid.appendChild(cell);
    }
    this._updateGridUI();
  },

  _toggleStep(i) {
    this.steps[i].active = !this.steps[i].active;
    this._updateStepUI(i);
  },

  _updateStepUI(i) {
    const grid = document.getElementById('synth-seq-grid');
    if (!grid) return;
    const cell = grid.children[i];
    if (!cell) return;
    const s = this.steps[i];

    cell.classList.toggle('on', s.active);
    const bar = cell.querySelector('.synth-step-bar');
    const lbl = cell.querySelector('.synth-step-pitch');

    if (s.active) {
      const norm = (s.pitch + 12) / 24;
      const h = 8 + norm * 82;
      bar.style.height = h + '%';
      lbl.textContent = (s.pitch > 0 ? '+' : '') + s.pitch;
    } else {
      bar.style.height = '0%';
      lbl.textContent = '';
    }
  },

  _updateGridUI() {
    for (let i = 0; i < this.NUM_STEPS; i++) {
      this._updateStepUI(i);
    }
  },

  _highlightStep(step) {
    const grid = document.getElementById('synth-seq-grid');
    if (!grid) return;
    grid.querySelectorAll('.synth-step').forEach(c => c.classList.remove('current'));
    if (step >= 0 && step < this.NUM_STEPS) grid.children[step]?.classList.add('current');
  },

  _toggleSeq() {
    this.seqActive = !this.seqActive;
    const btn = this.el.querySelector('.synth-seq-toggle');
    if (this.seqActive) {
      if (btn) { btn.classList.add('active'); btn.textContent = 'SEQ ON'; }
    } else {
      if (btn) { btn.classList.remove('active'); btn.textContent = 'SEQ'; }
    }
  },

  _randomizeSeq() {
    // Random 4-10 active steps with chromatic pitch ±12
    const count = 4 + Math.floor(Math.random() * 7);
    const indices = [];
    while (indices.length < count) {
      const idx = Math.floor(Math.random() * this.NUM_STEPS);
      if (!indices.includes(idx)) indices.push(idx);
    }
    for (let i = 0; i < this.NUM_STEPS; i++) {
      this.steps[i].active = indices.includes(i);
      this.steps[i].pitch = this.steps[i].active
        ? Math.floor(Math.random() * 25) - 12
        : 0;
    }
    this._updateGridUI();
    if (!this.seqActive) this._toggleSeq();
  },

  /**
   * Randomize with scale-constrained pitches
   * @param {string} scale - 'major' or 'minor'
   */
  _randomizeScale(scale) {
    const pitches = scale === 'major' ? this.MAJOR_PITCHES : this.MINOR_PITCHES;
    const count = 4 + Math.floor(Math.random() * 7);
    const indices = [];
    while (indices.length < count) {
      const idx = Math.floor(Math.random() * this.NUM_STEPS);
      if (!indices.includes(idx)) indices.push(idx);
    }
    for (let i = 0; i < this.NUM_STEPS; i++) {
      this.steps[i].active = indices.includes(i);
      this.steps[i].pitch = this.steps[i].active
        ? pitches[Math.floor(Math.random() * pitches.length)]
        : 0;
    }
    this._updateGridUI();
    if (!this.seqActive) this._toggleSeq();
  },

  stop() {
    // Nothing special needed - oscillators self-stop
  }
};
