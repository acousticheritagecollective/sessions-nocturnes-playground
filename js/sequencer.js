/* ═══════════════════════════════════════════
   SEQUENCER — CH05 32-step kick sequencer
   ═══════════════════════════════════════════ */

SN.Sequencer = {
  steps: new Array(32).fill(false),
  kickBuffer: null,
  kickPitch: 0,
  gainNode: null,
  sendGain: null,
  _initialized: false,

  init() {
    // Guard de idempotencia. Si init() corre dos veces, la segunda creaba
    // nuevos nodos en un contexto distinto y un segundo onStep listener.
    if (this._initialized) {
      console.warn('[Sequencer] init() llamado dos veces — ignorando');
      return;
    }
    this._initialized = true;

    const ctx = SN.AudioEngine.ctx;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0.8;
    // V2.8: pre-fader point (AUX PRE tap) — kick voices → preGain → fader
    this.preGain = ctx.createGain();
    this.preGain.gain.value = 1;
    this.preGain.connect(this.gainNode);
    // V2 MUTE (post-fader): gainNode(fader) → muteGain → master + sends
    this.muteGain = ctx.createGain();
    this.muteGain.gain.value = 1;
    this.gainNode.connect(this.muteGain);
    this.muteGain.connect(SN.AudioEngine.preFilterGain);

    this.sendGain = ctx.createGain();
    this.sendGain.gain.value = 0;
    this.sendRevGain = ctx.createGain();
    this.sendRevGain.gain.value = 0;
    this.sendDistGain = ctx.createGain();
    this.sendDistGain.gain.value = 0;
    this.muteGain.connect(this.sendGain);
    this.sendGain.connect(SN.AudioEngine.sendBus);
    this.muteGain.connect(this.sendRevGain);
    this.sendRevGain.connect(SN.AudioEngine.reverbSendBus);
    this.muteGain.connect(this.sendDistGain);
    this.sendDistGain.connect(SN.AudioEngine.distSendBus);

    if (!this.mute) this.mute = SN.Utils.bindMute(document.getElementById('kick-mute-btn'), () => this.muteGain);
    this._buildSteps();
    this._populateKickSelector();
    this._initRandomBtn();

    SN.Transport.onStep((step, time) => this._onStep(step, time));

    console.log('[Sequencer] Initialized (32 steps)');
  },

  _buildSteps() {
    const container = document.getElementById('seq-steps');
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
    const container = document.getElementById('seq-steps');
    const btn = container?.children[index];
    if (btn) btn.classList.toggle('on', this.steps[index]);
  },

  _populateKickSelector() {
    const select = document.getElementById('kick-sample-select');
    if (!select) return;

    select.innerHTML = '<option value="">— Select Kick —</option>';
    const samples = SN.Utils.sampleList('kicks-samples');
    samples.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.url;
      opt.textContent = s.name;
      select.appendChild(opt);
    });

    select.addEventListener('change', async () => {
      if (select.value) {
        this.kickBuffer = await SN.AudioEngine.loadSample(select.value);
        if (this.kickBuffer) console.log('[Sequencer] Kick loaded: ' + select.value);
      }
    });
  },

  _onStep(step, time) {
    this._highlightStep(step);
    if (step >= 0 && step < 32 && this.steps[step] && this.kickBuffer) {
      const ctx = SN.AudioEngine.ctx;
      const source = ctx.createBufferSource();
      source.buffer = this.kickBuffer;
      if (this.kickPitch !== 0) {
        source.playbackRate.value = Math.pow(2, this.kickPitch / 12);
      }
      source.connect(this.preGain);
      source.start(time);
    }
  },

  _highlightStep(step) {
    const container = document.getElementById('seq-steps');
    if (!container) return;
    container.querySelectorAll('.seq-step').forEach(btn => btn.classList.remove('current'));
    if (step >= 0 && step < 32) {
      const btn = container.children[step];
      if (btn) btn.classList.add('current');
    }
  },

  setGain(val) {
    this.gainNode.gain.setTargetAtTime(val, SN.AudioEngine.ctx.currentTime, 0.02);
  },

  setSendFx(val) {
    this.sendGain.gain.setTargetAtTime(val, SN.AudioEngine.ctx.currentTime, 0.02);
  },

  setSendRev(val) {
    this.sendRevGain.gain.setTargetAtTime(val, SN.AudioEngine.ctx.currentTime, 0.02);
  },

  setSendDist(val) {
    this.sendDistGain.gain.setTargetAtTime(val, SN.AudioEngine.ctx.currentTime, 0.02);
  },

  setPitch(semitones) {
    this.kickPitch = Math.round(semitones);
  },

  _initRandomBtn() {
    const btn = document.getElementById('kick-random-btn');
    if (btn) {
      btn.addEventListener('click', () => this.randomize());
    }
  },

  randomize() {
    this.steps.fill(false);
    // Always open downbeats: 1,5,9,13,17,21,25,29 (indices 0,4,8,12,16,20,24,28)
    const downbeats = [0, 4, 8, 12, 16, 20, 24, 28];
    downbeats.forEach(i => this.steps[i] = true);
    // Add 0-8 more random non-downbeat steps
    const extras = Math.floor(Math.random() * 9);
    const available = [];
    for (let i = 0; i < 32; i++) {
      if (!downbeats.includes(i)) available.push(i);
    }
    for (let n = 0; n < extras && available.length > 0; n++) {
      const pick = Math.floor(Math.random() * available.length);
      this.steps[available[pick]] = true;
      available.splice(pick, 1);
    }
    // Update UI
    const container = document.getElementById('seq-steps');
    if (container) {
      for (let i = 0; i < 32; i++) {
        container.children[i]?.classList.toggle('on', this.steps[i]);
      }
    }
  }
};
