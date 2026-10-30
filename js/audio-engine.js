/* ═══════════════════════════════════════════
   AUDIO ENGINE — Core AudioContext & routing
   
   FX CHAIN: delay → reverb → distortion
   Channel sends still feed each FX independently,
   but FX outputs cascade into the next stage.

   + SampleCache: decoded AudioBuffers memoized by URL
     so runtime loads are instant after preload.
   + masterAnalyser: passive tap on limiter output for VU meter
   V2: FX returns go through master HPF/LPF; output limiter
   ═══════════════════════════════════════════ */

SN.AudioEngine = {
  ctx: null,
  masterGain: null,
  masterAnalyser: null, // Passive tap for VU meter / scopes
  sendBus: null,      // Channel delay sends → delay input
  reverbSendBus: null, // Channel reverb sends + delay output → reverb input
  distSendBus: null,   // Channel dist sends + reverb output → distortion input
  fxReturnBus: null,   // FX outputs → preFilterGain (through master filters)
  preFilterGain: null,

  // URL → AudioBuffer cache (shared by all modules)
  _sampleCache: {},
  // URL → in-flight promise to dedupe concurrent requests for the same URL
  _inflight: {},

  async init() {
    // 'playback' = larger buffer, fewer underruns. No forced sampleRate.
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'playback'
    });
    await this._buildGraph();
    console.log(`[AudioEngine] Init @ ${this.ctx.sampleRate}Hz, latency=${(this.ctx.baseLatency*1000).toFixed(1)}ms`);
  },

  /* V2 core graph (also used by PerfMonitor rebuild):
       channels → preFilterGain → [HPF → LPF] → masterGain → LIMITER → destination
       FX returns → fxReturnBus → preFilterGain   (FX now pass through master filters)
       masterAnalyser taps the LIMITER output (what actually leaves the app) */
  async _buildGraph() {
    const ctx = this.ctx;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.8;

    // Output limiter (worklet, fallback = DynamicsCompressor)
    await SN.Limiter.init(ctx);
    this.masterGain.connect(SN.Limiter.input);
    SN.Limiter.output.connect(ctx.destination);

    // Analyser tap on limiter output (parallel, passive — does not affect signal)
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.masterAnalyser.smoothingTimeConstant = 0.3;
    SN.Limiter.output.connect(this.masterAnalyser);

    this.preFilterGain = ctx.createGain();
    this.preFilterGain.gain.value = 1;
    this.preFilterGain.connect(this.masterGain);

    // Send buses (channels feed these, post-fader & post-mute)
    this.sendBus = ctx.createGain();
    this.sendBus.gain.value = 1;

    this.reverbSendBus = ctx.createGain();
    this.reverbSendBus.gain.value = 1;

    this.distSendBus = ctx.createGain();
    this.distSendBus.gain.value = 1;

    // FX return → preFilterGain → master HPF/LPF → master → limiter
    this.fxReturnBus = ctx.createGain();
    this.fxReturnBus.gain.value = 1;
    this.fxReturnBus.connect(this.preFilterGain);
  },

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    if (SN.Cue && SN.Cue.resume) SN.Cue.resume();
  },

  setMasterGain(val) {
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(val, this.ctx.currentTime, 0.02);
  },

  async loadSample(url) {
    // Fast path: already decoded
    if (this._sampleCache[url]) {
      return this._sampleCache[url];
    }
    // Dedupe: if another caller is already fetching this URL, wait for it
    if (this._inflight[url]) {
      return this._inflight[url];
    }

    const p = (async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        const decoded = await this.ctx.decodeAudioData(buf);
        this._sampleCache[url] = decoded;
        return decoded;
      } catch (e) {
        console.warn(`[AudioEngine] Failed: ${url}`, e);
        return null;
      } finally {
        delete this._inflight[url];
      }
    })();

    this._inflight[url] = p;
    return p;
  },

  cacheSize() {
    return Object.keys(this._sampleCache).length;
  },

  clearCache() {
    this._sampleCache = {};
  },

  async getOutputDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audiooutput');
    } catch (e) { return []; }
  },

  /* ─── INPUT DEVICES (V2) ───
     Antes: la lista sólo se llenaba al pulsar READY y cualquier error de
     getUserMedia se tragaba en silencio (lista vacía, sin aviso).
     Ahora: se pide permiso una vez, se enumera SIEMPRE (aunque falle el
     permiso) y el error se guarda en lastInputError para mostrarlo. */
  lastInputError: null,
  _micPermissionAsked: false,

  async getInputDevices(askPermission) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      this.lastInputError = 'NO mediaDevices (¿https?)';
      return [];
    }
    if (askPermission !== false) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        this.lastInputError = null;
      } catch (e) {
        this.lastInputError = this._describeInputError(e);
        console.warn('[AudioEngine] Mic permission failed:', e);
      }
      this._micPermissionAsked = true;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audioinput');
    } catch (e) { return []; }
  },

  _describeInputError(e) {
    const n = (e && e.name) || 'Error';
    switch (n) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'PERMISO DENEGADO — revisa permiso de micrófono del sitio (candado) y macOS Ajustes › Privacidad › Micrófono › Chrome';
      case 'NotReadableError':
      case 'AbortError':
        return 'DISPOSITIVO OCUPADO / NO SE PUEDE ABRIR (' + n + ')';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'DISPOSITIVO NO ENCONTRADO (' + n + ')';
      default:
        return n + (e && e.message ? ': ' + e.message : '');
    }
  },

  async createInputStream(deviceId) {
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    // Intentos en cascada: multicanal exacto → exacto simple → preferido (no exacto)
    const attempts = [];
    if (deviceId) {
      attempts.push(Object.assign({ deviceId: { exact: deviceId }, channelCount: { ideal: 32 } }, base));
      attempts.push(Object.assign({ deviceId: { exact: deviceId } }, base));
      attempts.push(Object.assign({ deviceId: deviceId }, base));
    } else {
      attempts.push(Object.assign({ channelCount: { ideal: 32 } }, base));
      attempts.push(base);
    }
    let lastErr = null;
    for (const audio of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audio });
        this.lastInputError = null;
        return stream;
      } catch (e) {
        lastErr = e;
        console.warn('[AudioEngine] getUserMedia attempt failed', audio, e);
      }
    }
    this.lastInputError = this._describeInputError(lastErr);
    return null;
  },

  /* Shared input: one stream + one source + splitter per device.
     Several EXT channels can use different inputs (1, 2, 1+2…) of the
     same interface without opening it twice. Ref-counted. */
  _sharedInputs: {},

  async acquireInput(deviceId) {
    const key = deviceId || '__default__';
    let entry = this._sharedInputs[key];
    if (entry) {
      if (entry.pending) await entry.pending;
      entry = this._sharedInputs[key];
      if (entry && entry.source) { entry.refs++; return entry; }
    }
    const holder = { refs: 0, pending: null };
    this._sharedInputs[key] = holder;
    holder.pending = (async () => {
      const stream = await this.createInputStream(deviceId);
      if (!stream) { delete this._sharedInputs[key]; return null; }
      const track = stream.getAudioTracks()[0];
      const settings = track && track.getSettings ? track.getSettings() : {};
      const source = this.ctx.createMediaStreamSource(stream);
      const chCount = Math.max(1, settings.channelCount || source.channelCount || 2);
      const splitter = this.ctx.createChannelSplitter(Math.max(2, chCount));
      source.connect(splitter);
      Object.assign(holder, { key, stream, source, splitter, channelCount: chCount, label: track ? track.label : '' });
      return holder;
    })();
    const res = await holder.pending;
    holder.pending = null;
    if (!res) return null;
    holder.refs++;
    return holder;
  },

  releaseInput(entry) {
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    try { entry.source.disconnect(); } catch (e) {}
    try { entry.splitter.disconnect(); } catch (e) {}
    try { entry.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    if (this._sharedInputs[entry.key] === entry) delete this._sharedInputs[entry.key];
  },

  async setOutputDevice(deviceId) {
    if (this.ctx.setSinkId) {
      try { await this.ctx.setSinkId(deviceId); } catch (e) {}
    }
  }
};
