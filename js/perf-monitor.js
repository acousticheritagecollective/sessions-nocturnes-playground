/* ═══════════════════════════════════════════
   PERF MONITOR — Audio performance & latency
   CPU estimation, glitch detection, latency mode
   ═══════════════════════════════════════════ */

SN.PerfMonitor = {
  // State
  _active: false,
  _rafID: null,
  _panelEl: null,

  // Frame timing (main thread load estimation)
  _frameTimes: [],
  _frameMax: 60,
  _lastFrameTime: 0,

  // Audio glitch detection
  _lastAudioTime: 0,
  _lastWallTime: 0,
  _glitchCount: 0,
  _glitchThreshold: 0.05, // 50ms drift = probable underrun

  // Stats elements
  _els: {},

  // Latency mode (applied on next AudioContext creation)
  _latencyMode: 'playback',

  init() {
    this._panelEl = document.getElementById('perf-panel');
    if (!this._panelEl) return;

    this._els = {
      cpu:        document.getElementById('perf-cpu'),
      cpuBar:     document.getElementById('perf-cpu-bar'),
      latency:    document.getElementById('perf-latency'),
      output:     document.getElementById('perf-output-latency'),
      sampleRate: document.getElementById('perf-samplerate'),
      bufferMode: document.getElementById('perf-buffer-mode'),
      glitches:   document.getElementById('perf-glitches'),
      state:      document.getElementById('perf-ctx-state'),
    };

    this._initModeSelector();
    this._initToggle();

    console.log('[PerfMonitor] Init');
  },

  _initToggle() {
    const btn = document.getElementById('perf-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      this._active = !this._active;
      btn.classList.toggle('active', this._active);
      this._panelEl.classList.toggle('perf-visible', this._active);
      if (this._active) {
        this._start();
      } else {
        this._stop();
      }
    });
  },

  _initModeSelector() {
    const sel = document.getElementById('perf-buffer-mode');
    if (!sel) return;

    // Detect current mode
    const ctx = SN.AudioEngine.ctx;
    if (ctx) {
      const bl = ctx.baseLatency || 0;
      // Estimate which hint was used
      if (bl < 0.008) sel.value = 'interactive';
      else if (bl < 0.02) sel.value = 'balanced';
      else sel.value = 'playback';
      this._latencyMode = sel.value;
    }

    sel.addEventListener('change', () => {
      this._latencyMode = sel.value;
      this._applyLatencyMode(sel.value);
    });
  },

  // ─── APPLY LATENCY MODE ───
  // Requires recreating AudioContext — warns user
  _applyLatencyMode(mode) {
    const msg = 'Cambiar el buffer requiere reiniciar el audio engine.\n' +
                'Esto detendrá toda reproducción.\n\n' +
                '• interactive → menor latencia (~5ms), más CPU\n' +
                '• balanced → equilibrado (~12ms)\n' +
                '• playback → más estable (~40ms), menos CPU\n\n' +
                '¿Continuar?';

    if (!confirm(msg)) {
      // Revert selector
      const sel = document.getElementById('perf-buffer-mode');
      if (sel) sel.value = this._latencyMode;
      return;
    }

    this._rebuildAudioContext(mode);
  },

  async _rebuildAudioContext(latencyHint) {
    const oldCtx = SN.AudioEngine.ctx;

    // Stop everything
    SN.App._globalStop();

    // Close old context
    if (oldCtx) {
      try { await oldCtx.close(); } catch (e) {}
    }

    // Create new context with requested latency
    const NewCtx = window.AudioContext || window.webkitAudioContext;
    SN.AudioEngine.ctx = new NewCtx({ latencyHint: latencyHint });

    // Re-init the entire audio graph
    const ctx = SN.AudioEngine.ctx;

    // V2: same core graph as AudioEngine.init (filters, limiter, FX return)
    await SN.AudioEngine._buildGraph();

    // Re-init FX
    SN.GlobalFilters.init();
    SN.TapeDelay.init();
    SN.Reverb.init();
    SN.Distortion.init();

    // Re-init channels (they need new audio nodes)
    SN.App.channels.forEach(ch => {
      if (ch.rebuildAudioGraph) ch.rebuildAudioGraph();
    });

    // Re-init sequencer
    if (SN.Sequencer.init) SN.Sequencer.init();
    SN.Sequencer.gainNode.gain.value = 0.8 * 0.707;

    // Re-init ext input
    if (SN.ExtInput.init) SN.ExtInput.init();

    // Re-init track decks
    if (SN.App.trackDecks) {
      SN.App.trackDecks.forEach(d => { if (d.rebuildAudioGraph) d.rebuildAudioGraph(); });
    }

    // Apply master knob value
    if (SN.App.knobs.master) {
      const v = SN.App.knobs.master.getValue ? SN.App.knobs.master.getValue() : 0.8;
      SN.AudioEngine.setMasterGain(v);
    }

    this._latencyMode = latencyHint;
    this._glitchCount = 0;

    console.log('[PerfMonitor] AudioContext rebuilt — hint:', latencyHint,
      'baseLatency:', (ctx.baseLatency * 1000).toFixed(1) + 'ms',
      'sampleRate:', ctx.sampleRate);

    // Update display immediately
    this._updateStats();
  },

  // ─── MONITORING LOOP ───
  _start() {
    this._glitchCount = 0;
    this._lastFrameTime = performance.now();
    this._lastAudioTime = SN.AudioEngine.ctx ? SN.AudioEngine.ctx.currentTime : 0;
    this._lastWallTime = performance.now();
    this._frameTimes = [];
    this._tick();
  },

  _stop() {
    if (this._rafID) {
      cancelAnimationFrame(this._rafID);
      this._rafID = null;
    }
  },

  _tick() {
    if (!this._active) return;

    const now = performance.now();
    const ctx = SN.AudioEngine.ctx;

    // ── Frame timing (main thread CPU estimation) ──
    const frameDelta = now - this._lastFrameTime;
    this._lastFrameTime = now;
    this._frameTimes.push(frameDelta);
    if (this._frameTimes.length > this._frameMax) this._frameTimes.shift();

    // ── Glitch detection ──
    if (ctx && ctx.state === 'running') {
      const audioNow = ctx.currentTime;
      const wallElapsed = (now - this._lastWallTime) / 1000;
      const audioElapsed = audioNow - this._lastAudioTime;

      // If audio time advanced significantly less than wall time → underrun
      if (wallElapsed > 0.1 && audioElapsed > 0) {
        const drift = Math.abs(wallElapsed - audioElapsed);
        if (drift > this._glitchThreshold) {
          this._glitchCount++;
        }
      }

      this._lastAudioTime = audioNow;
      this._lastWallTime = now;
    }

    // Update display every ~250ms
    if (this._frameTimes.length % 15 === 0) {
      this._updateStats();
    }

    this._rafID = requestAnimationFrame(() => this._tick());
  },

  _updateStats() {
    const ctx = SN.AudioEngine.ctx;
    if (!ctx) return;

    // CPU estimation from frame timing
    // Ideal frame = 16.67ms (60fps). Higher = main thread busy
    const avgFrame = this._frameTimes.length > 0
      ? this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length
      : 16.67;
    // Estimate: if average frame > 16.67ms, thread is loaded
    const cpuEstimate = Math.min(100, Math.round((avgFrame / 16.67) * 100 - 50));
    // Clamp to 0-100 with a more useful range
    const cpuDisplay = Math.max(0, Math.min(100, cpuEstimate));

    if (this._els.cpu) this._els.cpu.textContent = cpuDisplay + '%';
    if (this._els.cpuBar) {
      this._els.cpuBar.style.width = cpuDisplay + '%';
      this._els.cpuBar.className = 'perf-bar-fill' +
        (cpuDisplay > 80 ? ' perf-bar-danger' :
         cpuDisplay > 50 ? ' perf-bar-warn' : '');
    }

    // Latency
    const base = ctx.baseLatency || 0;
    const output = ctx.outputLatency || 0;
    const totalMs = ((base + output) * 1000).toFixed(1);

    if (this._els.latency) this._els.latency.textContent = (base * 1000).toFixed(1) + ' ms';
    if (this._els.output) this._els.output.textContent = output > 0 ? (output * 1000).toFixed(1) + ' ms' : 'N/A';
    if (this._els.sampleRate) this._els.sampleRate.textContent = ctx.sampleRate + ' Hz';
    if (this._els.glitches) {
      this._els.glitches.textContent = this._glitchCount;
      this._els.glitches.className = 'perf-val' + (this._glitchCount > 0 ? ' perf-val-warn' : '');
    }
    if (this._els.state) {
      this._els.state.textContent = ctx.state;
      this._els.state.className = 'perf-val' +
        (ctx.state === 'running' ? ' perf-val-ok' :
         ctx.state === 'suspended' ? ' perf-val-warn' : ' perf-val-err');
    }
  }
};
