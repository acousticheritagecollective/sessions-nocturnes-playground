/* ═══════════════════════════════════════════
   APP — Main initialization & global wiring  V2
   FX: delay / reverb / distortion → master filters → master → limiter
   + MIDI Clock sync (internal/slave/master)
   + MIDI Learn (CC mapping, 4 controllers)
   V2: loop channels CH01-04 removed · 3 EXT IN · MUTE · output limiter
   ═══════════════════════════════════════════ */

SN.App = {
  channels: [],
  trackDecks: [],
  knobs: {},
  _initialized: false,
  _initPromise: null,

  async init() {
    // Guard de idempotencia: si ya se llamó, devolver la misma promesa.
    // Sin esto, dos llamadas concurrentes (boot + user gesture) crean dos
    // AudioContexts y dos sets de nodos cruzados → InvalidAccessError.
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  },

  async _doInit() {
    console.log('╔═══════════════════════════════════════╗');
    console.log('║  Sessions Nocturnes — DJ Mixer V2     ║');
    console.log('║  + MIDI Clock + MIDI Learn ×4         ║');
    console.log('╚═══════════════════════════════════════╝');

    await SN.AudioEngine.init();
    SN.Transport.init(127);
    SN.GlobalFilters.init();
    SN.TapeDelay.init();
    SN.Reverb.init();
    SN.Distortion.init();

    // MIDI Clock — init after transport
    await SN.MidiClock.init();

    // Kick sequencer
    SN.Sequencer.init();
    SN.Sequencer.gainNode.gain.value = 0.8 * 0.707;

    // External inputs (GOMEZ · RAVENTÓS · BALADO)
    SN.ExtInput.init();

    // Track decks A & B
    var deckEls = [
      { id: 'ch08a', name: 'A' },
      { id: 'ch08b', name: 'B' }
    ];
    deckEls.forEach(function(d) {
      var el = document.getElementById(d.id);
      if (el) this.trackDecks.push(new SN.TrackPlayer(d.name, el));
    }.bind(this));

    // MONITOR: per-channel MON switch → selectable monitor output (V2.6)
    SN.Cue.init();
    SN.Cue.attachAll();
    // AUX send (stereo, PRE/POST per channel) → selectable output (V2.8)
    SN.Aux.init();
    SN.Aux.attachAll();

    // UI helpers
    SN.UI.init();

    this._initGlobalControls();

    // Output limiter UI (knobs registered in SN.App.knobs → MIDI learnable)
    SN.Limiter.initUI();

    // Monitor output selector + level
    SN.Cue.initUI();
    SN.Aux.initUI();

    // MIDI Learn — init AFTER all knobs/faders are created
    SN.MidiLearn.init();
    // Performance monitor
    SN.PerfMonitor.init();


    // Preload every sample into cache so runtime loads are instant.
    // Runs AFTER all selects are populated by channels/decks/sequencer.
    await SN.SamplePreloader.run();

    // VU meter de salida
    SN.VuMeter.init();
    // Channel (post-fader) + FX level meters
    SN.LevelMeters.init();

    this._initialized = true;
    console.log('[App] Ready!');
  },

  _initGlobalControls() {
    const bpmInput = document.getElementById('bpm-display');
    const btnPlay = document.getElementById('btn-play');
    const btnStop = document.getElementById('btn-stop');

    // ─── BPM ───
    if (bpmInput) {
      bpmInput.addEventListener('change', () => {
        if (SN.MidiClock.mode === 'slave') return;
        const bpm = parseFloat(bpmInput.value);
        if (!isNaN(bpm)) this._setBPM(bpm);
      });
      bpmInput.addEventListener('wheel', (e) => {
        if (SN.MidiClock.mode === 'slave') return;
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.5 : -0.5;
        const bpm = parseFloat(bpmInput.value) + delta;
        bpmInput.value = SN.Utils.clamp(bpm, 60, 200).toFixed(1);
        this._setBPM(parseFloat(bpmInput.value));
      });
    }

    // ─── Transport ───
    if (btnPlay) {
      btnPlay.addEventListener('click', () => {
        SN.AudioEngine.resume();
        SN.Transport.play();
        btnPlay.classList.add('active');
        btnStop?.classList.remove('active');
        SN.MidiClock.masterSendStart();
      });
    }
    if (btnStop) {
      btnStop.addEventListener('click', () => {
        this._globalStop();
        btnStop.classList.add('active');
        btnPlay?.classList.remove('active');
      });
    }

    // ─── Master Gain ───
    const masterKnobEl = document.getElementById('master-gain-knob');
    if (masterKnobEl) {
      this.knobs.master = new SN.Knob(masterKnobEl, (p, v) => SN.AudioEngine.setMasterGain(v));
    }

    // ─── HPF ───
    const hpfToggle = document.getElementById('hpf-toggle');
    if (hpfToggle) {
      hpfToggle.addEventListener('click', () => {
        const active = hpfToggle.dataset.active !== 'true';
        hpfToggle.dataset.active = active;
        hpfToggle.classList.toggle('active', active);
        SN.GlobalFilters.setHPFActive(active);
      });
    }
    const hpfKnobEl = document.getElementById('hpf-freq-knob');
    if (hpfKnobEl) {
      this.knobs.hpf = new SN.Knob(hpfKnobEl, (p, v) => {
        SN.GlobalFilters.setHPFFreq(v);
        const d = document.getElementById('hpf-freq-val');
        if (d) d.textContent = SN.Utils.formatFreq(v);
      });
    }

    // ─── LPF ───
    const lpfToggle = document.getElementById('lpf-toggle');
    if (lpfToggle) {
      lpfToggle.addEventListener('click', () => {
        const active = lpfToggle.dataset.active !== 'true';
        lpfToggle.dataset.active = active;
        lpfToggle.classList.toggle('active', active);
        SN.GlobalFilters.setLPFActive(active);
      });
    }
    const lpfKnobEl = document.getElementById('lpf-freq-knob');
    if (lpfKnobEl) {
      this.knobs.lpf = new SN.Knob(lpfKnobEl, (p, v) => {
        SN.GlobalFilters.setLPFFreq(v);
        const d = document.getElementById('lpf-freq-val');
        if (d) d.textContent = SN.Utils.formatFreq(v);
      });
    }

    // ─── Delay ───
    const delayOutputKnob = document.getElementById('delay-output-knob');
    if (delayOutputKnob) {
      this.knobs.delayOutput = new SN.Knob(delayOutputKnob, (p, v) => SN.TapeDelay.setOutput(v));
    }
    const delayFeedbackKnob = document.getElementById('delay-feedback-knob');
    if (delayFeedbackKnob) {
      this.knobs.delayFeedback = new SN.Knob(delayFeedbackKnob, (p, v) => SN.TapeDelay.setFeedback(v));
    }
    const delayTimeKnob = document.getElementById('delay-time-knob');
    if (delayTimeKnob) {
      this.knobs.delayTime = new SN.Knob(delayTimeKnob, (p, v) => {
        SN.TapeDelay._freeTimeMs = v;
        if (SN.TapeDelay._division === 'free') SN.TapeDelay.setTimeMs(v);
        const d = document.getElementById('delay-time-val');
        if (d) d.textContent = Math.round(v) + ' ms';
      });
    }
    const syncBtns = document.getElementById('delay-sync-btns');
    if (syncBtns) {
      syncBtns.addEventListener('click', (e) => {
        const btn = e.target.closest('.sync-btn');
        if (!btn) return;
        syncBtns.querySelectorAll('.sync-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const division = btn.dataset.division;
        SN.TapeDelay.setDivision(division);
        if (division !== 'free') {
          const ms = SN.Utils.delayTimeForDivision(division, SN.Transport.bpm);
          if (ms && this.knobs.delayTime) this.knobs.delayTime.setValue(ms);
        }
      });
    }

    // ─── Reverb ───
    const reverbOutputKnob = document.getElementById('reverb-output-knob');
    if (reverbOutputKnob) {
      this.knobs.reverbOutput = new SN.Knob(reverbOutputKnob, (p, v) => SN.Reverb.setOutput(v));
    }
    const reverbDecayKnob = document.getElementById('reverb-decay-knob');
    if (reverbDecayKnob) {
      this.knobs.reverbDecay = new SN.Knob(reverbDecayKnob, (p, v) => SN.Reverb.setDecay(v));
    }
    const reverbDampKnob = document.getElementById('reverb-damp-knob');
    if (reverbDampKnob) {
      this.knobs.reverbDamp = new SN.Knob(reverbDampKnob, (p, v) => SN.Reverb.setDamp(v));
    }

    // ─── Distortion ───
    const distOutputKnob = document.getElementById('dist-output-knob');
    if (distOutputKnob) {
      this.knobs.distOutput = new SN.Knob(distOutputKnob, (p, v) => SN.Distortion.setOutput(v));
    }
    const distDriveKnob = document.getElementById('dist-drive-knob');
    if (distDriveKnob) {
      this.knobs.distDrive = new SN.Knob(distDriveKnob, (p, v) => SN.Distortion.setDrive(v));
    }
    const distToneKnob = document.getElementById('dist-tone-knob');
    if (distToneKnob) {
      this.knobs.distTone = new SN.Knob(distToneKnob, (p, v) => SN.Distortion.setTone(v));
    }

    // ─── Kick ───
    const kickFader = document.getElementById('kick-fader');
    if (kickFader) {
      kickFader.addEventListener('input', () => SN.Sequencer.setGain(parseFloat(kickFader.value)));
    }
    // V2.9 — kick sample knob: 0 = OFF, 1-20 = sample 01-20 (MIDI learnable)
    const kickSelKnob = document.getElementById('kick-select-knob');
    const kickSelect = document.getElementById('kick-sample-select');
    if (kickSelKnob && kickSelect) {
      let current = -1;
      this.knobs.kickSel = new SN.Knob(kickSelKnob, (p, v) => {
        const idx = Math.max(0, Math.min(kickSelect.options.length - 1, Math.round(v)));
        if (idx === current) return;
        current = idx;
        kickSelect.selectedIndex = idx;           // option 0 = "— Select Kick —"
        if (idx === 0) SN.Sequencer.kickBuffer = null;   // OFF = no kick
        else kickSelect.dispatchEvent(new Event('change'));
      });
      // Choosing with the mouse keeps the knob in sync
      kickSelect.addEventListener('change', () => {
        const idx = kickSelect.selectedIndex;
        if (idx === current) return;
        current = idx;
        if (idx === 0) SN.Sequencer.kickBuffer = null;
        this.knobs.kickSel.value = idx;
        this.knobs.kickSel._render();
      });
    }

    const kickPitchKnob = document.getElementById('kick-pitch-knob');
    if (kickPitchKnob) {
      this.knobs.kickPitch = new SN.Knob(kickPitchKnob, (p, v) => SN.Sequencer.setPitch(v));
    }
    const kickSendKnob = document.getElementById('kick-send-knob');
    if (kickSendKnob) {
      this.knobs.kickSend = new SN.Knob(kickSendKnob, (p, v) => SN.Sequencer.setSendFx(v));
    }
    const kickSendRevKnob = document.getElementById('kick-send-rev-knob');
    if (kickSendRevKnob) {
      this.knobs.kickSendRev = new SN.Knob(kickSendRevKnob, (p, v) => SN.Sequencer.setSendRev(v));
    }
    const kickSendDistKnob = document.getElementById('kick-send-dist-knob');
    if (kickSendDistKnob) {
      this.knobs.kickSendDist = new SN.Knob(kickSendDistKnob, (p, v) => SN.Sequencer.setSendDist(v));
    }

    // ─── Keyboard ───
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (SN.Transport.playing) {
          this._globalStop();
          btnStop?.classList.add('active');
          btnPlay?.classList.remove('active');
        } else {
          SN.AudioEngine.resume();
          SN.Transport.play();
          btnPlay?.classList.add('active');
          btnStop?.classList.remove('active');
          SN.MidiClock.masterSendStart();
        }
      }
      // ESC cancels MIDI Learn
      if (e.code === 'Escape' && SN.MidiLearn.learning) {
        SN.MidiLearn._cancelLearning();
      }
    });
  },

  _globalStop() {
    SN.Transport.stop();
    SN.ExtInput.stop();
    if (this.trackDecks) this.trackDecks.forEach(function(d) { d.globalStop(); });
    SN.MidiClock.masterSendStop();
  },

  _setBPM(bpm) {
    SN.Transport.setBPM(bpm);
    if (this.trackDecks) this.trackDecks.forEach(function(d) { d.onBPMChange(); });
    SN.TapeDelay.onBPMChange();
    SN.MidiClock.onBPMChange();
  }
};

// ─── Boot ───
// Una sola inicialización. Se intenta al cargar; si el AudioContext queda
// suspendido (sin user gesture), el primer click/keydown lo resume.
// Gracias al guard en App.init(), múltiples llamadas son seguras.
document.addEventListener('DOMContentLoaded', () => {
  SN.App.init().then(() => {
    const resume = () => {
      SN.AudioEngine.resume();
      document.removeEventListener('click', resume);
      document.removeEventListener('keydown', resume);
    };
    if (SN.AudioEngine.ctx && SN.AudioEngine.ctx.state === 'suspended') {
      console.log('[App] AudioContext suspended — esperando user gesture…');
      document.addEventListener('click', resume, { once: true });
      document.addEventListener('keydown', resume, { once: true });
    }
  }).catch(err => {
    console.error('[App] Init failed:', err);
  });
});
