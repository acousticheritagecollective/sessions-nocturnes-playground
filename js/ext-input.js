/* ═══════════════════════════════════════════
   EXT INPUT — External audio input channels (V2)
   3 instances: GOMEZ · RAVENTÓS · BALADO
   READY arms monitoring (closed by default)

   Chain: device[ch] → inputGain → readyGain → EQ → gate → fader
                     → MUTE → master + sends (post-fader)

   V2 fixes:
   - The device list is filled at boot and on every devicechange
     (before, it was only filled after pressing READY, so the
     interface never appeared in the select).
   - getUserMedia errors are shown in the channel (before: silent).
   - The selected device is used as is (before, with nothing selected
     it opened the system "default" device, usually the built-in mic).
   - IN selector: 1+2 (stereo) or any single input of the interface.
     Several channels share the same stream when they use the same device.
   ═══════════════════════════════════════════ */

SN.ExtInputChannel = class ExtInputChannel {
  constructor(el, idx) {
    this.el = el;
    this.idx = idx;              // 0 = GOMEZ, 1 = RAVENTÓS, 2 = BALADO
    this.armed = false;
    this.knobs = {};
    this.gateSteps = new Array(32).fill(false);
    this.gateActive = false;
    this._input = null;          // shared input entry from AudioEngine
    this._routeNode = null;
    this._storageKey = 'snm.extInput.v2.' + idx;

    const ctx = SN.AudioEngine.ctx;

    this.inputGain = ctx.createGain(); this.inputGain.gain.value = 1;
    this.readyGain = ctx.createGain(); this.readyGain.gain.value = 0; // READY on/off

    this.eqHi = ctx.createBiquadFilter();
    this.eqHi.type = 'peaking'; this.eqHi.frequency.value = 4500; this.eqHi.Q.value = 1; this.eqHi.gain.value = 0;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking'; this.eqMid.frequency.value = 1000; this.eqMid.Q.value = 1; this.eqMid.gain.value = 0;
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'peaking'; this.eqLow.frequency.value = 280; this.eqLow.Q.value = 1; this.eqLow.gain.value = 0;

    this.gateGain = ctx.createGain(); this.gateGain.gain.value = 1;
    this.faderGain = ctx.createGain(); this.faderGain.gain.value = 0.8;
    this.muteGain = ctx.createGain(); this.muteGain.gain.value = 1;

    this.sendGain = ctx.createGain(); this.sendGain.gain.value = 0;
    this.sendRevGain = ctx.createGain(); this.sendRevGain.gain.value = 0;
    this.sendDistGain = ctx.createGain(); this.sendDistGain.gain.value = 0;

    this.inputGain.connect(this.readyGain);
    this.readyGain.connect(this.eqHi);
    this.eqHi.connect(this.eqMid);
    this.eqMid.connect(this.eqLow);
    this.eqLow.connect(this.gateGain);
    this.gateGain.connect(this.faderGain);
    this.faderGain.connect(this.muteGain);
    this.muteGain.connect(SN.AudioEngine.preFilterGain);

    // Sends post-fader / post-mute
    this.muteGain.connect(this.sendGain);
    this.sendGain.connect(SN.AudioEngine.sendBus);
    this.muteGain.connect(this.sendRevGain);
    this.sendRevGain.connect(SN.AudioEngine.reverbSendBus);
    this.muteGain.connect(this.sendDistGain);
    this.sendDistGain.connect(SN.AudioEngine.distSendBus);

    this.deviceSelect = el.querySelector('.ext-device-select');
    this.chanSelect = el.querySelector('.ext-chan-select');
    this.readyBtn = el.querySelector('.ch-ready-btn');
    this.statusEl = el.querySelector('.ext-status');

    this._restorePrefs();
    this._initUI();
    SN.Transport.onStep((step, time) => this._onTransportStep(step, time));
  }

  _initUI() {
    this.el.querySelectorAll('.knob-wrap').forEach(knobEl => {
      const knob = new SN.Knob(knobEl, (param, value) => this._onKnobChange(param, value));
      this.knobs[knobEl.dataset.param] = knob;
    });

    const fader = this.el.querySelector('.channel-fader');
    if (fader) {
      fader.addEventListener('input', () => {
        this.faderGain.gain.setTargetAtTime(parseFloat(fader.value), SN.AudioEngine.ctx.currentTime, 0.02);
      });
    }

    this.mute = SN.Utils.bindMute(this.el.querySelector('.ch-mute-btn'), () => this.muteGain);

    if (this.readyBtn) this.readyBtn.addEventListener('click', () => this._toggleReady());

    if (this.deviceSelect) {
      // First interaction with the list → ask permission so labels/IDs show up
      this.deviceSelect.addEventListener('mousedown', () => SN.ExtInput.ensurePermission());
      this.deviceSelect.addEventListener('change', () => {
        this._savePrefs();
        this.deviceSelect.title = this.deviceSelect.selectedOptions[0] ? this.deviceSelect.selectedOptions[0].textContent : '';
        if (this.idx === 0) {
          const hdr = document.getElementById('audio-input');
          if (hdr && hdr.value !== this.deviceSelect.value) hdr.value = this.deviceSelect.value;
        }
        if (this.armed) this._openInput();
      });
    }
    if (this.chanSelect) {
      this.chanSelect.addEventListener('change', () => {
        this._savePrefs();
        this._routeInput();
      });
    }

    this._buildGateSeq();
  }

  _setStatus(text, isError) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text || '';
    this.statusEl.title = text || '';
    this.statusEl.classList.toggle('error', !!isError);
  }

  /* ─── Prefs (device label + input channel) ─── */
  _savePrefs() {
    try {
      const opt = this.deviceSelect && this.deviceSelect.selectedOptions[0];
      localStorage.setItem(this._storageKey, JSON.stringify({
        deviceId: this.deviceSelect ? this.deviceSelect.value : '',
        label: opt && opt.value ? opt.textContent : '',
        chan: this.chanSelect ? this.chanSelect.value : 'st'
      }));
    } catch (e) {}
  }
  _restorePrefs() {
    this._prefs = null;
    try { this._prefs = JSON.parse(localStorage.getItem(this._storageKey) || 'null'); } catch (e) {}
  }

  fillDevices(devices) {
    const select = this.deviceSelect;
    if (!select) return;
    const prev = select.value || (this._prefs && this._prefs.deviceId) || '';
    const prevLabel = (select.selectedOptions[0] && select.selectedOptions[0].value)
      ? select.selectedOptions[0].textContent : (this._prefs && this._prefs.label) || '';
    const usable = devices.filter(d => d.deviceId);
    select.innerHTML = usable.length
      ? '<option value="">— Select Input —</option>'
      : '<option value="">— Permitir micrófono —</option>';
    usable.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Input ' + (i + 1) + ' (' + d.deviceId.slice(0, 6) + ')');
      select.appendChild(opt);
    });
    // Restore selection by id, else by label (ids can change between sessions)
    let match = Array.from(select.options).find(o => o.value && o.value === prev);
    if (!match && prevLabel) match = Array.from(select.options).find(o => o.value && o.textContent === prevLabel);
    if (match) select.value = match.value;
    select.title = select.selectedOptions[0] ? select.selectedOptions[0].textContent : '';
  }

  async _toggleReady() {
    SN.AudioEngine.resume();
    if (this.armed) {
      this.armed = false;
      this.readyGain.gain.setTargetAtTime(0, SN.AudioEngine.ctx.currentTime, 0.01);
      if (this.readyBtn) { this.readyBtn.classList.remove('active'); this.readyBtn.textContent = 'READY'; }
      this._closeInput();
      this._setStatus('');
      return;
    }

    await SN.ExtInput.ensurePermission();
    if (!this.deviceSelect || !this.deviceSelect.value) {
      this._setStatus(SN.AudioEngine.lastInputError || 'ELIGE UNA ENTRADA', !!SN.AudioEngine.lastInputError);
      return;
    }
    await this._openInput();
    if (this._input) {
      this.armed = true;
      this.readyGain.gain.setTargetAtTime(1, SN.AudioEngine.ctx.currentTime, 0.01);
      if (this.readyBtn) { this.readyBtn.classList.add('active'); this.readyBtn.textContent = 'LIVE'; }
    }
  }

  async _openInput() {
    this._closeInput();
    const deviceId = this.deviceSelect ? this.deviceSelect.value : '';
    if (!deviceId) return;
    this._setStatus('ABRIENDO…');
    const entry = await SN.AudioEngine.acquireInput(deviceId);
    if (!entry) {
      this._setStatus(SN.AudioEngine.lastInputError || 'NO SE PUDO ABRIR', true);
      return;
    }
    this._input = entry;
    this._fillChannelOptions(entry.channelCount);
    this._routeInput();
  }

  _fillChannelOptions(count) {
    const sel = this.chanSelect;
    if (!sel) return;
    const want = sel.value || (this._prefs && this._prefs.chan) || 'st';
    sel.innerHTML = '';
    const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
    add('st', count >= 2 ? '1+2' : '1');
    for (let i = 0; i < count; i++) add(String(i), 'IN ' + (i + 1));
    sel.value = Array.from(sel.options).some(o => o.value === want) ? want : 'st';
  }

  _routeInput() {
    if (this._routeNode) {
      try { this._routeNode.disconnect(this.inputGain); } catch (e) {}
      this._routeNode = null;
    }
    const entry = this._input;
    if (!entry) return;
    const chan = this.chanSelect ? this.chanSelect.value : 'st';
    if (chan === 'st' || chan === '') {
      entry.source.connect(this.inputGain);
      this._routeNode = entry.source;
      this._setStatus(entry.channelCount + ' CH · 1+2');
    } else {
      const k = Math.min(parseInt(chan, 10) || 0, entry.channelCount - 1);
      // Mono input → upmixed to both sides (centered)
      entry.splitter.connect(this.inputGain, k);
      this._routeNode = entry.splitter;
      this._setStatus(entry.channelCount + ' CH · IN ' + (k + 1));
    }
  }

  _closeInput() {
    if (this._routeNode) {
      try { this._routeNode.disconnect(this.inputGain); } catch (e) {}
      this._routeNode = null;
    }
    if (this._input) {
      SN.AudioEngine.releaseInput(this._input);
      this._input = null;
    }
  }

  _onKnobChange(param, value) {
    const t = SN.AudioEngine.ctx.currentTime;
    switch (param) {
      case 'extGain': this.inputGain.gain.setTargetAtTime(value, t, 0.02); break;
      case 'extEqHi': this.eqHi.gain.setTargetAtTime(value, t, 0.02); break;
      case 'extEqMid': this.eqMid.gain.setTargetAtTime(value, t, 0.02); break;
      case 'extEqLow': this.eqLow.gain.setTargetAtTime(value, t, 0.02); break;
      case 'extSendDly': this.sendGain.gain.setTargetAtTime(value, t, 0.02); break;
      case 'extSendRev': this.sendRevGain.gain.setTargetAtTime(value, t, 0.02); break;
      case 'extSendDist': this.sendDistGain.gain.setTargetAtTime(value, t, 0.02); break;
      case 'auxSend': if (this.aux) this.aux.setLevel(value); break;
    }
  }

  /* ─── GATE SEQUENCER ─── */
  _buildGateSeq() {
    const container = this.el.querySelector('.gate-seq');
    if (!container) return;

    const toggleBtn = container.querySelector('.gate-toggle');
    if (toggleBtn) toggleBtn.addEventListener('click', () => this._toggleGateActive());

    const rndBtn = container.querySelector('.gate-random-btn');
    if (rndBtn) rndBtn.addEventListener('click', () => this._randomizeGate());

    const grid = container.querySelector('.gate-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (let i = 0; i < 32; i++) {
      const btn = document.createElement('button');
      btn.className = 'gate-step';
      btn.dataset.step = i;
      if (i % 4 === 0) btn.classList.add('beat');
      btn.addEventListener('click', () => {
        this.gateSteps[i] = !this.gateSteps[i];
        btn.classList.toggle('on', this.gateSteps[i]);
      });
      grid.appendChild(btn);
    }
  }

  _toggleGateActive() {
    this.gateActive = !this.gateActive;
    const container = this.el.querySelector('.gate-seq');
    const toggleBtn = container ? container.querySelector('.gate-toggle') : null;
    if (this.gateActive) {
      if (toggleBtn) { toggleBtn.classList.add('active'); toggleBtn.textContent = 'GATE ON'; }
      if (container) container.classList.add('active');
    } else {
      if (toggleBtn) { toggleBtn.classList.remove('active'); toggleBtn.textContent = 'GATE'; }
      if (container) container.classList.remove('active');
      this.gateGain.gain.setTargetAtTime(1, SN.AudioEngine.ctx.currentTime, 0.002);
    }
  }

  _randomizeGate() {
    this.gateSteps.fill(false);
    const count = 8 + Math.floor(Math.random() * 9);
    const indices = [];
    while (indices.length < count) {
      const idx = Math.floor(Math.random() * 32);
      if (!indices.includes(idx)) indices.push(idx);
    }
    indices.forEach(i => this.gateSteps[i] = true);
    const grid = this.el.querySelector('.gate-grid');
    if (grid) for (let i = 0; i < 32; i++) if (grid.children[i]) grid.children[i].classList.toggle('on', this.gateSteps[i]);
    if (!this.gateActive) this._toggleGateActive();
  }

  _onTransportStep(step, time) {
    if (this.gateActive && step >= 0 && step < 32) {
      const gateOpen = this.gateSteps[step] ? 1 : 0;
      this.gateGain.gain.setTargetAtTime(gateOpen, time, 0.002);
    }
    const grid = this.el ? this.el.querySelector('.gate-grid') : null;
    if (grid) {
      grid.querySelectorAll('.gate-step').forEach(btn => btn.classList.remove('current'));
      if (step >= 0 && step < 32 && grid.children[step]) grid.children[step].classList.add('current');
    }
  }

  stop() {
    this.gateGain.gain.setTargetAtTime(1, SN.AudioEngine.ctx.currentTime, 0.002);
  }
};

/* ─── Manager (keeps the old SN.ExtInput API: init / stop / populateInputDevices) ─── */
SN.ExtInput = {
  channels: [],
  _permissionPromise: null,
  _devListenerAdded: false,

  init() {
    this.channels = [];
    document.querySelectorAll('.channel-strip.ext-ch').forEach((el, i) => {
      this.channels.push(new SN.ExtInputChannel(el, i));
    });

    // Header INPUT select ↔ first EXT channel (GOMEZ), as before
    const headerSelect = document.getElementById('audio-input');
    if (headerSelect && !headerSelect._snBound) {
      headerSelect._snBound = true;
      headerSelect.addEventListener('mousedown', () => this.ensurePermission());
      headerSelect.addEventListener('change', () => {
        const ch = this.channels[0];
        if (!ch || !ch.deviceSelect) return;
        ch.deviceSelect.value = headerSelect.value;
        ch.deviceSelect.dispatchEvent(new Event('change'));
      });
    }

    if (navigator.mediaDevices && !this._devListenerAdded) {
      this._devListenerAdded = true;
      navigator.mediaDevices.addEventListener('devicechange', () => this.populateInputDevices(false));
    }

    // Fill lists right away (no prompt). If permission was already granted
    // labels appear immediately; otherwise first click on a list / READY asks.
    this.populateInputDevices(false);

    console.log('[ExtInput] Initialized —', this.channels.length, 'channels');
  },

  async _permissionAlreadyGranted() {
    try {
      if (!navigator.permissions) return false;
      const st = await navigator.permissions.query({ name: 'microphone' });
      return st.state === 'granted';
    } catch (e) { return false; }
  },

  ensurePermission() {
    if (!this._permissionPromise) {
      this._permissionPromise = this._permissionAlreadyGranted().then(granted => {
        // Already granted and lists have real devices → nothing to do
        const first = this.channels[0];
        const hasIds = first && first.deviceSelect && first.deviceSelect.options.length > 1;
        if (granted && hasIds) return;
        return this.populateInputDevices(true);
      }).then(() => {
        const err = SN.AudioEngine.lastInputError;
        if (err) {
          this.channels.forEach(ch => ch._setStatus(err, true));
          this._permissionPromise = null; // allow retry
        }
      });
    }
    return this._permissionPromise;
  },

  async populateInputDevices(askPermission) {
    const devices = await SN.AudioEngine.getInputDevices(askPermission);
    this.channels.forEach(ch => ch.fillDevices(devices));

    const headerSelect = document.getElementById('audio-input');
    if (headerSelect) {
      headerSelect.innerHTML = '<option value="">— Select Input —</option>';
      devices.filter(d => d.deviceId).forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || ('Input ' + (i + 1));
        headerSelect.appendChild(opt);
      });
      const first = this.channels[0];
      if (first && first.deviceSelect) headerSelect.value = first.deviceSelect.value;
    }
    return devices;
  },

  stop() {
    this.channels.forEach(ch => ch.stop());
  }
};
