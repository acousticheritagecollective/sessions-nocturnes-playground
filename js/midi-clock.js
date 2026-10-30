/* ═══════════════════════════════════════════
   MIDI CLOCK — Sync module
   Modes: INTERNAL | SLAVE (receive) | MASTER (send)
   Web MIDI API — 24 PPQN standard
   + CC + Note forwarding to MidiLearn
   V2: 4 independent MIDI LEARN inputs (slots 1-4), one per controller.
       Each slot keeps its own mappings, so two controllers sending the
       same CC never collide. Slot devices are remembered by name and
       re-connected automatically when the controller is plugged in.
   ═══════════════════════════════════════════ */

SN.MidiClock = {
  mode: 'internal',
  midiAccess: null,
  supported: false,
  selectedInput: null,
  selectedOutput: null,
  // V2 — CC learn slots
  SLOTS: 4,
  _ccInputs: [null, null, null, null],
  _ccHandlers: [null, null, null, null],
  _ccSlotNames: [null, null, null, null],
  _slotStorageKey: 'snm.midiLearn.slots.v2',

  // Slave BPM detection
  _clockTimes: [],
  _clockCount: 0,
  _slaveBPM: 0,
  _slaveRunning: false,
  _smoothBPM: 0,
  _bpmAlpha: 0.15,

  // Master clock generation
  _masterTimerID: null,
  _masterRunning: false,
  _masterPPQN: 0,

  // UI
  _statusEl: null,
  _bpmEl: null,
  _inputSelect: null,
  _outputSelect: null,
  _ccInputSelects: [],

  async init() {
    this._statusEl = document.getElementById('midi-status');
    this._bpmEl = document.getElementById('midi-bpm-display');
    this._inputSelect = document.getElementById('midi-input-select');
    this._outputSelect = document.getElementById('midi-output-select');
    this._ccInputSelects = [];
    for (let i = 0; i < this.SLOTS; i++) {
      this._ccInputSelects.push(document.querySelector('.midi-cc-slot-select[data-slot="' + (i + 1) + '"]'));
    }
    try {
      const saved = JSON.parse(localStorage.getItem(this._slotStorageKey) || 'null');
      if (Array.isArray(saved)) this._ccSlotNames = [0, 1, 2, 3].map(i => saved[i] || null);
    } catch (e) {}

    if (!navigator.requestMIDIAccess) {
      this._setStatus('NO MIDI', 'error');
      this.supported = false;
      return;
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.supported = true;
      this._setStatus('INTERNAL', 'off');
      this._refreshDevices();
      this.midiAccess.onstatechange = () => this._refreshDevices();
      this._initUI();
      console.log('[MidiClock] Init OK —', this.midiAccess.inputs.size, 'in,', this.midiAccess.outputs.size, 'out');
    } catch (e) {
      this._setStatus('DENIED', 'error');
      this.supported = false;
    }
  },

  _refreshDevices() {
    if (!this.midiAccess) return;
    const inputs = [], outputs = [];
    this.midiAccess.inputs.forEach(i => inputs.push({ id: i.id, name: i.name || i.id, mfr: i.manufacturer || '' }));
    this.midiAccess.outputs.forEach(o => outputs.push({ id: o.id, name: o.name || o.id, mfr: o.manufacturer || '' }));

    const fill = (sel, placeholder) => {
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = '<option value="">' + placeholder + '</option>';
      inputs.forEach(d => {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = d.name + (d.mfr ? ' (' + d.mfr + ')' : '');
        o.dataset.name = d.name;
        sel.appendChild(o);
      });
      if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
    };
    fill(this._inputSelect, '— No Input —');
    this._ccInputSelects.forEach((sel, i) => {
      fill(sel, (i + 1) + ' · —');
      // Auto-reconnect remembered controller (by name)
      if (sel && !sel.value && this._ccSlotNames[i]) {
        const opt = Array.from(sel.options).find(o => o.dataset.name === this._ccSlotNames[i]);
        if (opt) sel.value = opt.value;
      }
      if (sel) sel.title = 'MIDI LEARN ' + (i + 1) + ': ' + (sel.selectedOptions[0] && sel.value ? sel.selectedOptions[0].textContent : '—');
    });

    if (this._outputSelect) {
      const prev = this._outputSelect.value;
      this._outputSelect.innerHTML = '<option value="">— No Output —</option>';
      outputs.forEach(d => {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = d.name + (d.mfr ? ' (' + d.mfr + ')' : '');
        this._outputSelect.appendChild(o);
      });
      if (prev && Array.from(this._outputSelect.options).some(o => o.value === prev)) this._outputSelect.value = prev;
    }

    // (Re)attach CC listeners — idempotent, also handles hot-plug
    if (this._uiReady) this._connectAllCC();
  },

  _initUI() {
    document.querySelectorAll('.midi-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
    });
    if (this._inputSelect) this._inputSelect.addEventListener('change', () => {
      if (this.mode === 'slave') { this._stopSlave(); this._startSlave(); }
    });
    if (this._outputSelect) this._outputSelect.addEventListener('change', () => {
      if (this.mode === 'master') { this._stopMaster(); this._startMaster(); }
    });
    this._ccInputSelects.forEach((sel, i) => {
      if (!sel) return;
      sel.addEventListener('change', () => {
        // Same controller can't sit in two slots
        if (sel.value) {
          this._ccInputSelects.forEach((other, j) => {
            if (j !== i && other && other.value === sel.value) { other.value = ''; this._ccSlotNames[j] = null; }
          });
        }
        const opt = sel.selectedOptions[0];
        this._ccSlotNames[i] = sel.value && opt ? opt.dataset.name : null;
        sel.title = 'MIDI LEARN ' + (i + 1) + ': ' + (sel.value && opt ? opt.textContent : '—');
        this._saveSlots();
        this._connectAllCC();
      });
    });
    this._uiReady = true;
    this._connectAllCC();
  },

  _saveSlots() {
    try { localStorage.setItem(this._slotStorageKey, JSON.stringify(this._ccSlotNames)); } catch (e) {}
  },

  // Select slot devices by name (used when loading a mapping file)
  setSlotDeviceNames(names) {
    if (!Array.isArray(names)) return;
    names.forEach((name, i) => {
      const sel = this._ccInputSelects[i];
      if (!sel || !name) return;
      const opt = Array.from(sel.options).find(o => o.dataset.name === name);
      this._ccSlotNames[i] = name;
      if (opt) sel.value = opt.value;
    });
    this._saveSlots();
    this._connectAllCC();
  },

  getSlotDeviceNames() {
    return this._ccSlotNames.slice();
  },

  // ─── CC INPUTS (for MIDI Learn, separate from clock) — V2: 4 slots ───
  _connectAllCC() {
    for (let i = 0; i < this.SLOTS; i++) this._connectCCSlot(i);
  },

  _connectCCSlot(i) {
    const prevInput = this._ccInputs[i];
    if (prevInput && this._ccHandlers[i]) prevInput.removeEventListener('midimessage', this._ccHandlers[i]);
    this._ccInputs[i] = null;
    this._ccHandlers[i] = null;

    const sel = this._ccInputSelects[i];
    if (!this.midiAccess || !sel || !sel.value) return;
    const input = this.midiAccess.inputs.get(sel.value);
    if (!input) return;

    const slot = i + 1;
    const handler = (e) => this._forwardToLearn(e.data, slot);
    input.addEventListener('midimessage', handler);
    if (input.open) { try { input.open(); } catch (e) {} }
    this._ccInputs[i] = input;
    this._ccHandlers[i] = handler;
    if (!prevInput || prevInput !== input) console.log('[MidiClock] CC slot ' + slot + ':', input.name);
  },

  _isCCSlotInput(input) {
    return !!input && this._ccInputs.some(inp => inp && inp.id === input.id);
  },

  // Forward CC + Note messages to MidiLearn.
  // Notes are mapped to a virtual channel (ch + 16) so the "ch:number" key
  // never collides with a real CC mapping.
  _forwardToLearn(d, slot) {
    if (!SN.MidiLearn || !d || d.length < 3) return;
    slot = slot || 1;
    const status = d[0] & 0xF0;
    const ch = d[0] & 0x0F;

    if (status === 0xB0) {
      // Control Change
      SN.MidiLearn.onMIDICC(ch, d[1], d[2], slot);
    } else if (status === 0x90) {
      // Note On — velocity 0 counts as Note Off
      const vel = d[2];
      SN.MidiLearn.onMIDICC(ch + 16, d[1], vel > 0 ? 127 : 0, slot);
    } else if (status === 0x80) {
      // Note Off
      SN.MidiLearn.onMIDICC(ch + 16, d[1], 0, slot);
    }
  },

  // ─── MODE SWITCHING ───
  setMode(mode) {
    if (mode === this.mode) return;
    this._stopSlave(); this._stopMaster();
    this.mode = mode;
    document.querySelectorAll('.midi-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    const inRow = document.getElementById('midi-input-row');
    const outRow = document.getElementById('midi-output-row');
    if (inRow) inRow.style.display = mode === 'slave' ? 'flex' : 'none';
    if (outRow) outRow.style.display = mode === 'master' ? 'flex' : 'none';
    switch (mode) {
      case 'internal': this._setStatus('INTERNAL', 'off'); if (this._bpmEl) this._bpmEl.textContent = ''; break;
      case 'slave': this._startSlave(); break;
      case 'master': this._startMaster(); break;
    }
    this._connectAllCC();
    console.log('[MidiClock] Mode →', mode);
  },

  // ═══ SLAVE ═══
  _startSlave() {
    if (!this.midiAccess) return;
    const id = this._inputSelect ? this._inputSelect.value : '';
    if (!id) { this._setStatus('NO DEVICE', 'warn'); return; }
    const input = this.midiAccess.inputs.get(id);
    if (!input) { this._setStatus('NOT FOUND', 'error'); return; }
    this.selectedInput = input;
    this._clockTimes = []; this._clockCount = 0; this._slaveBPM = 0; this._smoothBPM = 0; this._slaveRunning = false;
    input.onmidimessage = (e) => this._onMIDIMessage(e);
    this._setStatus('LISTENING', 'slave');
    console.log('[MidiClock] Slave on:', input.name);
  },

  _stopSlave() {
    if (this.selectedInput) { this.selectedInput.onmidimessage = null; this.selectedInput = null; }
    this._slaveRunning = false; this._clockTimes = []; this._clockCount = 0;
  },

  _onMIDIMessage(event) {
    const d = event.data;
    if (!d || !d.length) return;
    switch (d[0]) {
      case 0xF8: this._onClock(event.timeStamp || performance.now()); return;
      case 0xFA: this._onStart(); return;
      case 0xFB: this._onContinue(); return;
      case 0xFC: this._onStop(); return;
    }
    // Forward CC + Note messages to MidiLearn (slot 1) — unless this same
    // device is already assigned to a LEARN slot (that listener handles it)
    if (!this._isCCSlotInput(this.selectedInput)) this._forwardToLearn(d, 1);
  },

  _onClock(ts) {
    this._clockTimes.push(ts); this._clockCount++;
    if (this._clockTimes.length > 48) this._clockTimes.shift();
    if (this._clockTimes.length >= 24) {
      const len = this._clockTimes.length;
      const avg = (this._clockTimes[len - 1] - this._clockTimes[len - 24]) / 23;
      const instant = 60000 / (avg * 24);
      this._smoothBPM = this._smoothBPM === 0 ? instant : this._bpmAlpha * instant + (1 - this._bpmAlpha) * this._smoothBPM;
      this._slaveBPM = Math.round(this._smoothBPM * 10) / 10;
      if (this._clockCount % 24 === 0) {
        if (this._bpmEl) this._bpmEl.textContent = this._slaveBPM.toFixed(1);
        if (this._slaveRunning) {
          SN.Transport.setBPM(this._slaveBPM);
          const inp = document.getElementById('bpm-display');
          if (inp) inp.value = this._slaveBPM.toFixed(1);
          SN.App._setBPM(this._slaveBPM);
        }
      }
    }
  },

  _onStart() {
    this._slaveRunning = true; this._clockTimes = []; this._clockCount = 0;
    this._setStatus('SYNCED ▶', 'sync');
    if (!SN.Transport.playing) {
      SN.AudioEngine.resume(); SN.Transport.play();
      document.getElementById('btn-play')?.classList.add('active');
      document.getElementById('btn-stop')?.classList.remove('active');
    }
  },
  _onContinue() {
    this._slaveRunning = true; this._setStatus('SYNCED ▶', 'sync');
    if (!SN.Transport.playing) { SN.AudioEngine.resume(); SN.Transport.play(); }
  },
  _onStop() {
    this._slaveRunning = false; this._setStatus('LISTENING', 'slave');
    if (SN.Transport.playing) {
      SN.App._globalStop();
      document.getElementById('btn-play')?.classList.remove('active');
      document.getElementById('btn-stop')?.classList.add('active');
    }
  },

  // ═══ MASTER ═══
  _startMaster() {
    if (!this.midiAccess) return;
    const id = this._outputSelect ? this._outputSelect.value : '';
    if (!id) { this._setStatus('NO DEVICE', 'warn'); return; }
    const output = this.midiAccess.outputs.get(id);
    if (!output) { this._setStatus('NOT FOUND', 'error'); return; }
    this.selectedOutput = output; this._masterPPQN = 0;
    this._setStatus('MASTER', 'master');
    if (this._bpmEl) this._bpmEl.textContent = SN.Transport.bpm.toFixed(1);
    if (SN.Transport.playing) this._masterSendStart();
  },

  _stopMaster() {
    if (this._masterTimerID) { clearInterval(this._masterTimerID); this._masterTimerID = null; }
    if (this.selectedOutput && this._masterRunning) this.selectedOutput.send([0xFC]);
    this._masterRunning = false; this.selectedOutput = null;
  },

  masterSendStart() {
    if (this.mode !== 'master' || !this.selectedOutput) return;
    this._masterSendStart();
  },
  _masterSendStart() {
    if (this._masterRunning) return;
    this._masterRunning = true; this._masterPPQN = 0;
    this.selectedOutput.send([0xFA]);
    this._setStatus('MASTER ▶', 'sync');
    this._startClockGen();
  },
  masterSendStop() {
    if (this.mode !== 'master' || !this.selectedOutput) return;
    if (this._masterTimerID) { clearInterval(this._masterTimerID); this._masterTimerID = null; }
    this.selectedOutput.send([0xFC]);
    this._masterRunning = false; this._setStatus('MASTER', 'master');
  },

  _startClockGen() {
    if (this._masterTimerID) clearInterval(this._masterTimerID);
    let last = performance.now(), acc = 0;
    const tick = () => {
      if (!this._masterRunning || !this.selectedOutput) { clearInterval(this._masterTimerID); this._masterTimerID = null; return; }
      const now = performance.now(), iv = 60000 / (SN.Transport.bpm * 24);
      acc += now - last; last = now;
      while (acc >= iv) { this.selectedOutput.send([0xF8]); this._masterPPQN++; acc -= iv; }
    };
    this._masterTimerID = setInterval(tick, 1);
  },

  onBPMChange() {
    if (this.mode === 'master' && this._bpmEl) this._bpmEl.textContent = SN.Transport.bpm.toFixed(1);
  },

  _setStatus(text, type) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text;
    this._statusEl.className = 'midi-status';
    if (type) this._statusEl.classList.add('midi-status-' + type);
  }
};