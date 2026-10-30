/* ═══════════════════════════════════════════
   OUTPUT ROUTING · MONITOR · AUX SEND   (V2.8)

   SN.OutRouter — sends a stereo bus to any output device Chrome sees
   (interface, BlackHole, Mac headphones…) on any channel pair (1-2 … 7-8).
     · same device as master → main AudioContext, extra channels (no drift)
     · other device          → second AudioContext with its own sink

   SN.Cue (MONITOR) — per-channel MON button:
     OFF → channel to master (+ FX sends) as always
     ON  → channel leaves the master (FX sends cut too) and plays ONLY
           on the monitor output. Post-fader & post-mute.

   SN.Aux (AUX SEND) — stereo aux send per channel, knob + PRE/POST:
     POST (default) = after fader, MUTE and MON (exactly what goes to master)
     PRE            = before the fader (after EQ/filters/gate); MUTE still cuts it
   ═══════════════════════════════════════════ */

SN.OutRouter = class OutRouter {
  constructor(opts) {
    this.name = opts.name;
    this.bus = opts.bus;                 // GainNode (main ctx)
    this.devSel = opts.devSel;
    this.pairSel = opts.pairSel;
    this.onStatus = opts.onStatus || function() {};
    this.storageKey = opts.storageKey;
    this.deviceId = '';
    this.pair = 0;
    this.N = 0;
    this.mode = null;
    this.error = null;
    this._nodes = {};
    this._ctx2 = null;
    this._token = 0;
    try {
      const p = JSON.parse(localStorage.getItem(this.storageKey) || 'null');
      if (p) { this._prefs = p; this.pair = p.pair | 0; }
    } catch (e) {}

    if (this.devSel) this.devSel.addEventListener('change', () => {
      this.deviceId = this.devSel.value;
      this.devSel.title = this.devSel.selectedOptions[0] ? this.devSel.selectedOptions[0].textContent : '';
      this._save(); SN.AudioEngine.resume(); this.apply();
    });
    if (this.pairSel) this.pairSel.addEventListener('change', () => {
      this.pair = parseInt(this.pairSel.value, 10) || 0;
      this._save(); this.apply();
    });
    const master = document.getElementById('audio-output');
    if (master) master.addEventListener('change', () => setTimeout(() => this.apply(), 400));
    if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => this.populate());
  }

  _save() {
    try {
      const o = this.devSel && this.devSel.selectedOptions[0];
      localStorage.setItem(this.storageKey, JSON.stringify({ deviceId: this.deviceId, label: o && o.value ? o.textContent : '', pair: this.pair }));
    } catch (e) {}
  }

  async populate() {
    const sel = this.devSel;
    if (!sel) return;
    const devices = await SN.AudioEngine.getOutputDevices();
    const prevId = sel.value || (this._prefs && this._prefs.deviceId) || '';
    const prevLabel = (sel.selectedOptions[0] && sel.value) ? sel.selectedOptions[0].textContent : (this._prefs && this._prefs.label) || '';
    sel.innerHTML = '<option value="">— Off —</option>';
    devices.forEach((d, i) => {
      if (!d.deviceId && i > 0) return;
      const o = document.createElement('option');
      o.value = d.deviceId || 'default';
      o.textContent = d.label || ('Output ' + (i + 1));
      sel.appendChild(o);
    });
    let match = Array.from(sel.options).find(o => o.value && o.value === prevId);
    if (!match && prevLabel) match = Array.from(sel.options).find(o => o.value && o.textContent === prevLabel);
    sel.value = match ? match.value : '';
    sel.title = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
    this.deviceId = sel.value;
  }

  _fillPairs(nCh) {
    const sel = this.pairSel;
    const pairs = Math.max(1, Math.floor(nCh / 2));
    if (this.pair > (pairs - 1) * 2) this.pair = 0;
    if (!sel) return;
    sel.innerHTML = '';
    for (let p = 0; p < pairs; p++) {
      const o = document.createElement('option');
      o.value = String(p * 2);
      o.textContent = (p * 2 + 1) + '-' + (p * 2 + 2);
      sel.appendChild(o);
    }
    sel.value = String(this.pair);
  }

  _isMasterDevice(id) {
    const m = document.getElementById('audio-output');
    const mv = (m && m.value) || 'default';
    return id === mv || (id === 'default' && (mv === '' || mv === 'default'));
  }

  _teardown() {
    const n = this._nodes;
    if (n.split) { try { n.split.disconnect(); } catch (e) {} }
    if (n.merger) { try { n.merger.disconnect(); } catch (e) {} }
    if (n.split) { try { this.bus.disconnect(n.split); } catch (e) {} }
    if (n.streamDest) { try { this.bus.disconnect(n.streamDest); } catch (e) {} }
    if (this._ctx2) { try { this._ctx2.close(); } catch (e) {} this._ctx2 = null; }
    if (n.mainMulti) SN.OutRouter._releaseMainMulti(this);
    this._nodes = {};
    this.mode = null;
    this.N = 0;
  }

  async apply() {
    const token = ++this._token;
    this._teardown();
    const ctx = SN.AudioEngine.ctx;
    const id = this.deviceId;
    this.error = null;
    if (!id) { this._fillPairs(2); this.onStatus(); return; }
    try {
      if (this._isMasterDevice(id)) {
        const dest = ctx.destination;
        const N = Math.max(2, dest.maxChannelCount || 2);
        this._fillPairs(N);
        const merger = ctx.createChannelMerger(N);
        const split = ctx.createChannelSplitter(2);
        this.bus.connect(split);
        split.connect(merger, 0, this.pair);
        split.connect(merger, 1, this.pair + 1);
        if (N > 2) SN.OutRouter._claimMainMulti(this, N);
        merger.connect(dest);
        this._nodes = { split, merger, mainMulti: N > 2 };
        this.mode = 'same'; this.N = N;
      } else {
        const streamDest = ctx.createMediaStreamDestination();
        streamDest.channelCount = 2;
        this.bus.connect(streamDest);
        const ctx2 = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        if (ctx2.setSinkId) await ctx2.setSinkId(id === 'default' ? '' : id);
        if (token !== this._token) { try { ctx2.close(); } catch (e) {} try { this.bus.disconnect(streamDest); } catch (e) {} return; }
        const dest = ctx2.destination;
        const N = Math.max(2, dest.maxChannelCount || 2);
        this._fillPairs(N);
        const src = ctx2.createMediaStreamSource(streamDest.stream);
        const split = ctx2.createChannelSplitter(2);
        const merger = ctx2.createChannelMerger(N);
        src.connect(split);
        split.connect(merger, 0, this.pair);
        split.connect(merger, 1, this.pair + 1);
        if (N > 2) { dest.channelCount = N; dest.channelInterpretation = 'discrete'; }
        merger.connect(dest);
        this._ctx2 = ctx2;
        this._nodes = { streamDest };
        this.mode = 'other'; this.N = N;
        if (ctx2.state === 'suspended') ctx2.resume().catch(() => {});
      }
    } catch (e) {
      console.warn('[' + this.name + '] Routing failed:', e);
      this.error = (e && e.name) || 'ERROR';
    }
    this.onStatus();
  }

  resume() {
    if (this._ctx2 && this._ctx2.state === 'suspended') this._ctx2.resume().catch(() => {});
  }

  pairLabel() { return (this.pair + 1) + '-' + (this.pair + 2); }
};

// Several routers may need extra channels on the master device at once
SN.OutRouter._multiUsers = new Map();
SN.OutRouter._claimMainMulti = function(router, N) {
  SN.OutRouter._multiUsers.set(router, N);
  const dest = SN.AudioEngine.ctx.destination;
  const need = Math.max.apply(null, Array.from(SN.OutRouter._multiUsers.values()));
  if (dest.channelCount !== need) dest.channelCount = need;
  dest.channelInterpretation = 'discrete';
};
SN.OutRouter._releaseMainMulti = function(router) {
  SN.OutRouter._multiUsers.delete(router);
  if (SN.OutRouter._multiUsers.size === 0) {
    const dest = SN.AudioEngine.ctx.destination;
    try { dest.channelCount = 2; dest.channelInterpretation = 'speakers'; } catch (e) {}
  }
};

/* ═══ MONITOR ═══ */
SN.Cue = {
  bus: null,
  level: 1,
  router: null,
  _channels: [],

  init() {
    this.bus = SN.AudioEngine.ctx.createGain();
    this.bus.gain.value = this.level;
  },

  get deviceId() { return this.router ? this.router.deviceId : ''; },
  get pair() { return this.router ? this.router.pair : 0; },
  get _nodes() { return this.router ? { mode: this.router.mode, N: this.router.N } : {}; },
  get _cueCtx() { return this.router ? this.router._ctx2 : null; },
  get _error() { return this.router ? this.router.error : null; },

  /* muteGain → outSwitch → master + sends      (MON off)
     muteGain → cueSwitch → monitor bus         (MON on) */
  attach(muteGain, sends, btn, label) {
    const ctx = SN.AudioEngine.ctx;
    const pre = SN.AudioEngine.preFilterGain;
    try { muteGain.disconnect(pre); } catch (e) {}
    sends.forEach(s => { try { muteGain.disconnect(s); } catch (e) {} });

    const outSwitch = ctx.createGain(); outSwitch.gain.value = 1;
    const cueSwitch = ctx.createGain(); cueSwitch.gain.value = 0;
    muteGain.connect(outSwitch);
    outSwitch.connect(pre);
    sends.forEach(s => outSwitch.connect(s));
    muteGain.connect(cueSwitch);
    cueSwitch.connect(this.bus);

    const ch = { label, btn, outSwitch, cueSwitch, on: false };
    ch.set = (on) => {
      ch.on = !!on;
      const t = SN.AudioEngine.ctx.currentTime;
      outSwitch.gain.setTargetAtTime(ch.on ? 0 : 1, t, 0.008);
      cueSwitch.gain.setTargetAtTime(ch.on ? 1 : 0, t, 0.008);
      if (btn) btn.classList.toggle('active', ch.on);
      this._updateStatus();
    };
    if (btn) btn.addEventListener('click', () => { SN.AudioEngine.resume(); ch.set(!ch.on); });
    this._channels.push(ch);
    return ch;
  },

  attachAll() {
    const A = SN.App;
    A.trackDecks.forEach(d => {
      d.monitor = this.attach(d.muteGain, [d.sendGain, d.sendRevGain, d.sendDistGain], d.el.querySelector('.ch-mon-btn'), 'DECK ' + d.deckId);
    });
    const S = SN.Sequencer;
    S.monitor = this.attach(S.muteGain, [S.sendGain, S.sendRevGain, S.sendDistGain], document.getElementById('kick-mon-btn'), 'KICKS');
    (SN.ExtInput.channels || []).forEach((c, i) => {
      c.monitor = this.attach(c.muteGain, [c.sendGain, c.sendRevGain, c.sendDistGain], c.el.querySelector('.ch-mon-btn'), 'EXT ' + (i + 1));
    });
  },

  initUI() {
    this._statusEl = document.getElementById('cue-status');
    const knobEl = document.getElementById('cue-level-knob');
    if (knobEl) SN.App.knobs.cueLevel = new SN.Knob(knobEl, (p, v) => {
      this.level = v;
      this.bus.gain.setTargetAtTime(v, SN.AudioEngine.ctx.currentTime, 0.02);
    });
    this.router = new SN.OutRouter({
      name: 'Monitor', bus: this.bus, storageKey: 'snm.cue.v1',
      devSel: document.getElementById('cue-output-select'),
      pairSel: document.getElementById('cue-pair-select'),
      onStatus: () => this._updateStatus()
    });
    this.router.populate().then(() => this.router.apply());
    this._updateStatus();
  },

  apply() { return this.router && this.router.apply(); },
  resume() { if (this.router) this.router.resume(); if (SN.Aux.router) SN.Aux.router.resume(); },

  _updateStatus() {
    if (!this._statusEl) return;
    const r = this.router;
    const on = this._channels.filter(c => c.on).map(c => c.label);
    let txt;
    if (r && r.error) txt = 'ERROR: ' + r.error;
    else if (!r || !r.deviceId) txt = on.length ? 'SIN SALIDA — ' + on.join(', ') + ' NO SUENA' : 'OFF';
    else txt = (on.length ? 'MON: ' + on.join(', ') : 'LISTO') + ' → ' + r.pairLabel() + (r.N ? ' · ' + r.N + ' CH' : '');
    this._statusEl.textContent = txt;
    this._statusEl.title = txt;
    this._statusEl.classList.toggle('warn', (!(r && r.deviceId) && on.length > 0) || !!(r && r.error));
    this._statusEl.classList.toggle('active', on.length > 0 && !!(r && r.deviceId));
  }
};

/* ═══ AUX SEND ═══ */
SN.Aux = {
  bus: null,
  router: null,
  _channels: [],

  init() {
    this.bus = SN.AudioEngine.ctx.createGain();
    this.bus.gain.value = 1;
  },

  /* preNode  → preSel  ┐
     postNode → postSel ┴→ level(knob) → aux bus
     PRE also follows the channel MUTE. */
  attach(preNode, postNode, muteState, btn, label) {
    const ctx = SN.AudioEngine.ctx;
    const preSel = ctx.createGain(); preSel.gain.value = 0;
    const postSel = ctx.createGain(); postSel.gain.value = 1;
    const level = ctx.createGain(); level.gain.value = 0;
    preNode.connect(preSel);
    postNode.connect(postSel);
    preSel.connect(level);
    postSel.connect(level);
    level.connect(this.bus);

    const ch = { label, btn, preSel, postSel, level, pre: false };
    const apply = () => {
      const t = SN.AudioEngine.ctx.currentTime;
      const muted = !!(muteState && muteState.muted);
      preSel.gain.setTargetAtTime(ch.pre && !muted ? 1 : 0, t, 0.008);
      postSel.gain.setTargetAtTime(ch.pre ? 0 : 1, t, 0.008);
      if (btn) {
        btn.classList.toggle('active', ch.pre);
        btn.textContent = (btn.classList.contains('aux-labeled') ? 'AUX ' : '') + (ch.pre ? 'PRE' : 'POST');
      }
    };
    ch.setPre = (on) => { ch.pre = !!on; apply(); };
    ch.setLevel = (v) => level.gain.setTargetAtTime(v, SN.AudioEngine.ctx.currentTime, 0.02);
    if (muteState && muteState.onChange) muteState.onChange(apply);
    if (btn) btn.addEventListener('click', () => { SN.AudioEngine.resume(); ch.setPre(!ch.pre); });
    apply();
    this._channels.push(ch);
    return ch;
  },

  attachAll() {
    const A = SN.App;
    A.trackDecks.forEach(d => {
      d.aux = this.attach(d.gateGain, d.monitor.outSwitch, d.mute, d.el.querySelector('.aux-mode-btn'), 'DECK ' + d.deckId);
    });
    const S = SN.Sequencer;
    S.aux = this.attach(S.preGain, S.monitor.outSwitch, S.mute, document.getElementById('kick-aux-mode-btn'), 'KICKS');
    (SN.ExtInput.channels || []).forEach((c, i) => {
      c.aux = this.attach(c.gateGain, c.monitor.outSwitch, c.mute, c.el.querySelector('.aux-mode-btn'), 'EXT ' + (i + 1));
    });
    // V2.10 FX → AUX: PRE = wet at full level, POST = after the FX OUT knob
    [['delay', SN.TapeDelay, 'DELAY'], ['reverb', SN.Reverb, 'REVERB'], ['dist', SN.Distortion, 'DIST']].forEach(([id, fx, label]) => {
      if (fx && fx.wetGain && fx.outputGain) fx.aux = this.attach(fx.wetGain, fx.outputGain, null, document.getElementById(id + '-aux-mode-btn'), label);
    });
  },

  initUI() {
    this._statusEl = document.getElementById('aux-status');
    const kickKnob = document.getElementById('kick-aux-knob');
    if (kickKnob) SN.App.knobs.kickAux = new SN.Knob(kickKnob, (p, v) => SN.Sequencer.aux && SN.Sequencer.aux.setLevel(v));
    [['delay', SN.TapeDelay], ['reverb', SN.Reverb], ['dist', SN.Distortion]].forEach(([id, fx]) => {
      const el = document.getElementById(id + '-aux-knob');
      if (el) SN.App.knobs[id + 'Aux'] = new SN.Knob(el, (p, v) => fx.aux && fx.aux.setLevel(v));
    });
    const lvl = document.getElementById('aux-level-knob');
    if (lvl) SN.App.knobs.auxLevel = new SN.Knob(lvl, (p, v) => this.bus.gain.setTargetAtTime(v, SN.AudioEngine.ctx.currentTime, 0.02));
    this.router = new SN.OutRouter({
      name: 'Aux', bus: this.bus, storageKey: 'snm.aux.v1',
      devSel: document.getElementById('aux-output-select'),
      pairSel: document.getElementById('aux-pair-select'),
      onStatus: () => this._updateStatus()
    });
    this.router.populate().then(() => this.router.apply());
    this._updateStatus();
  },

  _updateStatus() {
    if (!this._statusEl) return;
    const r = this.router;
    let txt;
    if (r && r.error) txt = 'ERROR: ' + r.error;
    else if (!r || !r.deviceId) txt = 'OFF';
    else txt = '→ ' + r.pairLabel() + (r.N ? ' · ' + r.N + ' CH' : '');
    this._statusEl.textContent = txt;
    this._statusEl.title = txt;
    this._statusEl.classList.toggle('active', !!(r && r.deviceId && !r.error));
    this._statusEl.classList.toggle('warn', !!(r && r.error));
  }
};
