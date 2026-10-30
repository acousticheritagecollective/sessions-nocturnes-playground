/* ═══════════════════════════════════════════
   TRACK PLAYER — DECK A  v12

   SYNC: _barDur = buffer.duration / totalBars
   RATE: _barDur * globalBPM / 240
   RESYNC: every bar boundary (not during loop)
   LOOP: dedicated ON/OFF toggle, size buttons separate
         ON  → pending → boundary → END=here START=END-size
         OFF → continue from _pos(), resync catches drift
   ═══════════════════════════════════════════ */

const TRACK_DB = {
  '01': { bars: 253, bpm: 100 }, '02': { bars: 284, bpm: 100 },
  '03': { bars: 304, bpm: 100 }, '04': { bars: 344, bpm: 117 },
  '05': { bars: 290, bpm: 130 }, '06': { bars: 420, bpm: 130 },
  '07': { bars: 668, bpm: 127 }, '08': { bars: 372, bpm: 127 },
  '09': { bars: 946, bpm: 128 }, '10': { bars: 680, bpm: 127 },
  '11': { bars: 452, bpm: 126 }, '12': { bars: 434, bpm: 121 },
  '13': { bars:  95, bpm: 121 }, '14': { bars: 309, bpm: 115 },
  '15': { bars: 284, bpm: 107 }, '16': { bars: 356, bpm: 107 },
  '17': { bars: 117, bpm: 107 }, '18': { bars: 550, bpm: 126 },
  '19': { bars: 538, bpm: 126 }, '20': { bars: 552, bpm: 130 },
  '21': { bars: 728, bpm: 130 }, '22': { bars: 524, bpm: 120 },
  '23': { bars: 523, bpm: 120 }, '24': { bars: 355, bpm: 110 },
  '25': { bars: 561, bpm: 122 }, '26': { bars: 504, bpm: 122 },
  '27': { bars: 501, bpm: 126 }, '28': { bars: 452, bpm: 126 },
  '29': { bars: 528, bpm: 100 },
};

/* ═══ TRACK PEAKS — waveform overview cache (V2.2) ═══
   Same output as the old _computeWaveform (200 points/s, min/max of ch0),
   but computed in ~4 ms slices so audio scheduling never stalls. */
SN.TrackPeaks = {
  _cache: {},
  _inflight: {},
  PPS: 200,
  get(url) { return this._cache[url] || null; },
  _yield() {
    return new Promise(function(r) {
      if (typeof MessageChannel !== 'undefined') {
        var ch = new MessageChannel(); ch.port1.onmessage = function() { r(); }; ch.port2.postMessage(0);
      } else setTimeout(r, 0);
    });
  },
  compute(url, buffer) {
    if (this._cache[url]) return Promise.resolve(this._cache[url]);
    if (this._inflight[url]) return this._inflight[url];
    var self = this;
    var p = (async function() {
      var raw = buffer.getChannelData(0), pps = self.PPS;
      var total = Math.ceil(buffer.duration * pps);
      var step = Math.max(1, Math.floor(raw.length / total));
      var hi = new Float32Array(total), lo = new Float32Array(total);
      var i = 0;
      while (i < total) {
        var t0 = performance.now();
        while (i < total && performance.now() - t0 < 4) {
          var lim = Math.min(total, i + 64);
          for (; i < lim; i++) {
            var mn = 1, mx = -1;
            var off = i * step, end = Math.min(off + step, raw.length);
            for (var j = off; j < end; j++) { var v = raw[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
            hi[i] = mx; lo[i] = mn;
          }
        }
        if (i < total) await self._yield();
      }
      var res = { hi: hi, lo: lo };
      if (url.indexOf('__direct__') !== 0) self._cache[url] = res;
      delete self._inflight[url];
      return res;
    })();
    this._inflight[url] = p;
    return p;
  }
};

SN.TrackPlayer = class TrackPlayer {
  constructor(deckId, el) {
    this.deckId = deckId;
    this.el = el;
    this.knobs = {};
    var ctx = SN.AudioEngine.ctx;

    this._srcGain = ctx.createGain(); this._srcGain.gain.value = 1;
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass'; this.hpf.frequency.value = 20; this.hpf.Q.value = 0.7;
    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass'; this.lpf.frequency.value = 20000; this.lpf.Q.value = 0.7;
    this.gateGain  = ctx.createGain(); this.gateGain.gain.value = 1;
    this.faderGain = ctx.createGain(); this.faderGain.gain.value = 0.8;
    this.muteGain  = ctx.createGain(); this.muteGain.gain.value = 1;   // V2 MUTE (post-fader)
    this.sendGain     = ctx.createGain(); this.sendGain.gain.value = 0;
    this.sendRevGain  = ctx.createGain(); this.sendRevGain.gain.value = 0;
    this.sendDistGain = ctx.createGain(); this.sendDistGain.gain.value = 0;

    this._srcGain.connect(this.hpf);
    this.hpf.connect(this.lpf);
    this.lpf.connect(this.gateGain);
    this.gateGain.connect(this.faderGain);
    this.faderGain.connect(this.muteGain);
    // Main out + sends tapped AFTER fader & mute (post-fader)
    this.muteGain.connect(SN.AudioEngine.preFilterGain);
    this.muteGain.connect(this.sendGain);     this.sendGain.connect(SN.AudioEngine.sendBus);
    this.muteGain.connect(this.sendRevGain);  this.sendRevGain.connect(SN.AudioEngine.reverbSendBus);
    this.muteGain.connect(this.sendDistGain); this.sendDistGain.connect(SN.AudioEngine.distSendBus);

    this.buffer = null; this.sourceNode = null;
    this.playing = false; this._pendingPlay = false;
    this._startedAt = 0; this._offsetAt = 0;

    this.sourceBpm = 0; this.totalBars = 0;
    this._barDur  = 0;
    this._16thDur = 0;

    this._jumpBar = -1;

    this.gateSteps = new Array(16).fill(true);
    this.gateActive = false;
    /* V2.5 gate envelope: ATK / REL knobs (ms to ~95 %). Default 6 ms =
       the previous fixed time constant (0.002 s), so it sounds as before. */
    this.gateAtkMs = 6;
    this.gateRelMs = 6;
    this._gateOpen = true;

    this._waveHi = null; this._waveLo = null;
    this._zoomBars = 8; this._rafId = null; this._cachedAccent = null;
    this._userScrollOffset = 0; this._isUserScrolling = false; this._scrollTimer = null;

    /* LOOP — toggle separate from size */
    this.loopActive = false;
    this.loopSize = 1;
    this.loopStartBuf = 0;
    this.loopEndBuf = 0;
    this._pendingLoop = false;

    this.hpfActive = false; this.lpfActive = false;
    this._FADE = 0.006;

    this._initUI();
    SN.Transport.onStep(function(s, t) { this._onStep(s, t); }.bind(this));
  }

  _rate() { return this._barDur ? this._barDur * SN.Transport.bpm / 240 : 1; }

  _applyRate() {
    if (!this.sourceNode) return;
    var pos = this._pos();
    var now = SN.AudioEngine.ctx.currentTime;
    var r = this._rate();
    this.sourceNode.playbackRate.setValueAtTime(r, now);
    this._startedAt = now - pos / r;
  }

  _barStart(n) { return n * this._barDur; }
  _barAt(t)    { return this._barDur > 0 ? Math.floor(t / this._barDur) : 0; }
  _stepInBar(t) {
    if (!this._16thDur) return 0;
    var inBar = ((t % this._barDur) + this._barDur) % this._barDur;
    return Math.floor(inBar / this._16thDur);
  }
  _snapBar(t) { return this._barDur ? Math.round(t / this._barDur) * this._barDur : t; }

  _loopQuantum() {
    var s = Math.round(this.loopSize * 16);
    return Math.max(1, Math.min(s, 16));
  }

  _pos() {
    if (!this.playing || !this.buffer) return this._offsetAt || 0;
    var rate = this._rate();
    if (rate <= 0) return this._offsetAt || 0;
    var elapsed = (SN.AudioEngine.ctx.currentTime - this._startedAt) * rate;
    if (this.loopActive && this.loopSize > 0) {
      var ls = this.loopStartBuf, le = this.loopEndBuf, len = le - ls;
      if (len > 0) {
        if (elapsed >= le) return ls + ((elapsed - ls) % len + len) % len;
        if (elapsed < ls) return ls;
        return elapsed;
      }
    }
    var d = this.buffer.duration;
    if (d > 0) return ((elapsed % d) + d) % d;
    return 0;
  }

  /* ═══ UI ═══ */

  _initUI() {
    var self = this;
    this.el.querySelectorAll('.knob-wrap').forEach(function(k) {
      var knob = new SN.Knob(k, function(p, v) { self._onKnob(p, v); });
      self.knobs[k.dataset.param] = knob;
    });
    var fader = this.el.querySelector('.channel-fader');
    if (fader) fader.addEventListener('input', function(e) {
      self.faderGain.gain.setTargetAtTime(+e.target.value, SN.AudioEngine.ctx.currentTime, 0.02);
    });
    this.mute = SN.Utils.bindMute(this.el.querySelector('.ch-mute-btn'), function() { return self.muteGain; });
    this._populateSelector();
    var playBtn = this.el.querySelector('.tk-play-btn');
    if (playBtn) playBtn.addEventListener('click', function() { self._togglePlay(); });
    var cueBtn = this.el.querySelector('.tk-cue-btn');
    if (cueBtn) cueBtn.addEventListener('click', function() { self._cue(); });
    var hpfBtn = this.el.querySelector('.tk-hpf-toggle');
    if (hpfBtn) hpfBtn.addEventListener('click', function(e) {
      self.hpfActive = !self.hpfActive;
      e.currentTarget.classList.toggle('active', self.hpfActive);
      if (!self.hpfActive) self.hpf.frequency.setTargetAtTime(20, SN.AudioEngine.ctx.currentTime, 0.02);
    });
    var lpfBtn = this.el.querySelector('.tk-lpf-toggle');
    if (lpfBtn) lpfBtn.addEventListener('click', function(e) {
      self.lpfActive = !self.lpfActive;
      e.currentTarget.classList.toggle('active', self.lpfActive);
      if (!self.lpfActive) self.lpf.frequency.setTargetAtTime(20000, SN.AudioEngine.ctx.currentTime, 0.02);
    });
    this._initLoopBtns();
    this._initWaveformInput();
    this._initGateSeq();
    this._startRAF();
  }

  _populateSelector() {
    var sel = this.el.querySelector('.tk-track-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Track --</option>';
    for (var i = 1; i <= 29; i++) {
      var n = String(i).padStart(2, '0'), d = TRACK_DB[n];
      var o = document.createElement('option');
      o.value = 'samples/tracks/' + n + '.mp3';
      o.textContent = n + '  ' + d.bpm + 'bpm  ' + d.bars + 'b';
      sel.appendChild(o);
    }
    var self = this;
    sel.addEventListener('change', function() { if (sel.value) self._load(sel.value); self._syncBrowse(); });
    this._initBrowse(sel);
  }

  /* ═══ TRACK BROWSE − / + (V2.7) ═══
     − / + move through the list; the display shows the browsed track.
     Deck stopped → loads by itself ~350 ms after the last press.
     Deck playing → only browses (display blinks); press the display to load,
     so the music is never cut by accident. All three are MIDI-learnable. */
  _initBrowse(sel) {
    var self = this;
    this._browseIdx = -1;
    this._browseTimer = null;
    this._browseDisp = this.el.querySelector('.tk-browse-display');
    var prev = this.el.querySelector('.tk-browse-prev');
    var next = this.el.querySelector('.tk-browse-next');
    if (prev) prev.addEventListener('click', function() { self._browseStep(-1); });
    if (next) next.addEventListener('click', function() { self._browseStep(1); });
    if (this._browseDisp) this._browseDisp.addEventListener('click', function() { self._browseLoad(); });
    this._syncBrowse();
  }

  _trackCount() {
    var sel = this.el.querySelector('.tk-track-select');
    return sel ? sel.options.length - 1 : 0;
  }

  _loadedIdx() {
    var sel = this.el.querySelector('.tk-track-select');
    return sel ? sel.selectedIndex - 1 : -1;
  }

  _browseStep(dir) {
    var n = this._trackCount(); if (n <= 0) return;
    var cur = this._browseIdx >= 0 ? this._browseIdx : this._loadedIdx();
    if (cur < 0) cur = dir > 0 ? -1 : 0;
    this._browseIdx = ((cur + dir) % n + n) % n;
    this._renderBrowse();
    clearTimeout(this._browseTimer);
    var self = this;
    if (!this.playing && !this._pendingPlay) {
      this._browseTimer = setTimeout(function() { self._browseLoad(); }, 350);
    }
  }

  _browseLoad() {
    clearTimeout(this._browseTimer);
    var sel = this.el.querySelector('.tk-track-select');
    if (!sel || this._browseIdx < 0) return;
    if (this._browseIdx === this._loadedIdx()) { this._renderBrowse(); return; }
    sel.selectedIndex = this._browseIdx + 1;
    sel.dispatchEvent(new Event('change'));
  }

  _syncBrowse() {
    this._browseIdx = this._loadedIdx();
    this._renderBrowse();
  }

  _renderBrowse() {
    var d = this._browseDisp; if (!d) return;
    var sel = this.el.querySelector('.tk-track-select');
    var idx = this._browseIdx;
    if (idx < 0 || !sel) { d.innerHTML = '<span class="tk-bd-num">--</span>'; d.classList.remove('pending'); return; }
    var n = String(idx + 1).padStart(2, '0'), info = TRACK_DB[n];
    d.innerHTML = '<span class="tk-bd-num">' + n + '</span>' + (info ? '<span class="tk-bd-bpm">' + info.bpm + '</span>' : '');
    var pending = idx !== this._loadedIdx();
    d.classList.toggle('pending', pending);
    d.title = pending ? 'Pulsa para cargar el track ' + n : 'Track ' + n + ' cargado';
  }

  /* ═══ GATE ═══ */

  _initGateSeq() {
    var c = this.el.querySelector('.gate-seq'); if (!c) return;
    var self = this;
    var tog = c.querySelector('.gate-toggle');
    if (tog) tog.addEventListener('click', function() { self._toggleGate(); });
    var rnd = c.querySelector('.gate-random-btn');
    if (rnd) rnd.addEventListener('click', function() { self._randomizeGate(); });
    var grid = c.querySelector('.gate-grid'); if (!grid) return;
    grid.innerHTML = '';
    for (var i = 0; i < 16; i++) {
      var btn = document.createElement('button');
      btn.className = 'gate-step on'; btn.dataset.step = i;
      (function(idx) { btn.addEventListener('click', function() { self._toggleGateStep(idx); }); })(i);
      grid.appendChild(btn);
    }
  }
  _toggleGate() {
    this.gateActive = !this.gateActive;
    var btn = this.el.querySelector('.gate-toggle');
    if (this.gateActive) { if (btn) { btn.classList.add('active'); btn.textContent = 'GATE ON'; } }
    else { if (btn) { btn.classList.remove('active'); btn.textContent = 'GATE'; }
      this.gateGain.gain.setTargetAtTime(1, SN.AudioEngine.ctx.currentTime, 0.002); }
  }
  _toggleGateStep(i) {
    this.gateSteps[i] = !this.gateSteps[i];
    var grid = this.el.querySelector('.gate-grid');
    if (grid && grid.children[i]) grid.children[i].classList.toggle('on', this.gateSteps[i]);
  }
  _randomizeGate() {
    var dens = 0.4 + Math.random() * 0.4;
    for (var i = 0; i < 16; i++) this.gateSteps[i] = Math.random() < dens;
    this.gateSteps[0] = true;
    var grid = this.el.querySelector('.gate-grid');
    if (grid) for (var i2 = 0; i2 < 16; i2++)
      if (grid.children[i2]) grid.children[i2].classList.toggle('on', this.gateSteps[i2]);
    if (!this.gateActive) this._toggleGate();
  }
  _highlightGateStep(step) {
    var grid = this.el.querySelector('.gate-grid'); if (!grid) return;
    var s = step >= 0 ? step % 16 : -1;
    for (var i = 0; i < grid.children.length; i++)
      grid.children[i].classList.toggle('current', i === s);
  }

  /* ═══ LOAD ═══ */

  async _load(url) {
    this._fadeStop(); this._jumpBar = -1;
    this.loopActive = false; this._pendingLoop = false;
    var token = this._loadToken = (this._loadToken || 0) + 1;
    this.buffer = await SN.AudioEngine.loadSample(url);
    if (!this.buffer || token !== this._loadToken) return;
    var m = url.match(/(\d{2})\.mp3/);
    var info = m ? TRACK_DB[m[1]] : null;
    this.sourceBpm = info ? info.bpm : 120;
    this.totalBars = info ? info.bars : 1;
    this._barDur  = this.buffer.duration / this.totalBars;
    this._16thDur = this._barDur / 16;
    /* V2.2: waveform peaks come precomputed from the preload (cache).
       If missing, they're computed in small slices without blocking the
       main thread (before: ~180 ms freeze on long tracks → late kicks / drop). */
    var cached = SN.TrackPeaks.get(url);
    if (cached) { this._waveHi = cached.hi; this._waveLo = cached.lo; }
    else {
      this._waveHi = null; this._waveLo = null;
      var self = this, buf = this.buffer;
      SN.TrackPeaks.compute(url, buf).then(function(pk) {
        if (pk && token === self._loadToken && self.buffer === buf) { self._waveHi = pk.hi; self._waveLo = pk.lo; }
      });
    }
    this._offsetAt = 0; this._userScrollOffset = 0;
    this._updatePlayBtn(false); this._updateLoopUI(); this._highlightSizeBtn();
    var bpmEl = this.el.querySelector('.tk-bpm-info .detected');
    if (bpmEl) bpmEl.textContent = '' + this.sourceBpm;
    console.log('[Deck ' + this.deckId + '] Loaded ' + (m ? m[1] : '??') +
      ': ' + this.totalBars + 'bars, barDur=' + this._barDur.toFixed(4) +
      's, rate@' + SN.Transport.bpm + '=' + this._rate().toFixed(4));
  }

  _computeWaveform() {
    // Kept for compatibility — now non-blocking via SN.TrackPeaks
    if (!this.buffer) return;
    var self = this, buf = this.buffer;
    SN.TrackPeaks.compute('__direct__' + Math.random(), buf).then(function(pk) {
      if (pk && self.buffer === buf) { self._waveHi = pk.hi; self._waveLo = pk.lo; }
    });
  }

  /* ═══ PLAYBACK ═══ */

  _startSource(bufOffset, when) {
    var ctx = SN.AudioEngine.ctx;
    when = when || ctx.currentTime;
    var off = SN.Utils.clamp(bufOffset, 0, this.buffer.duration - 0.001);
    this.sourceNode = ctx.createBufferSource();
    this.sourceNode.buffer = this.buffer;
    this.sourceNode.playbackRate.value = this._rate();
    this.sourceNode.loop = true;
    if (this.loopActive && this.loopSize > 0) {
      this.sourceNode.loopStart = this.loopStartBuf;
      this.sourceNode.loopEnd   = this.loopEndBuf;
    } else {
      this.sourceNode.loopStart = 0;
      this.sourceNode.loopEnd   = this.buffer.duration;
    }
    this.sourceNode.connect(this._srcGain);
    this.sourceNode.start(when, off);
    this._startedAt = when - off / this._rate();
    this._offsetAt  = off;
    this.playing = true;
  }

  play(when) {
    if (!this.buffer) return;
    this._killSource();
    when = when || SN.AudioEngine.ctx.currentTime;
    this._srcGain.gain.cancelScheduledValues(when);
    this._srcGain.gain.setValueAtTime(0.001, when);
    this._srcGain.gain.exponentialRampToValueAtTime(1, when + this._FADE);
    this._startSource(this._offsetAt, when);
    this._updatePlayBtn(true);
  }

  _fadeStop() {
    if (!this.playing && !this.sourceNode) return;
    if (this.playing) this._offsetAt = this._pos();
    var now = SN.AudioEngine.ctx.currentTime;
    if (this.sourceNode) {
      this._srcGain.gain.cancelScheduledValues(now);
      this._srcGain.gain.setValueAtTime(this._srcGain.gain.value, now);
      this._srcGain.gain.exponentialRampToValueAtTime(0.001, now + this._FADE);
      this.sourceNode.stop(now + this._FADE + 0.002); this.sourceNode = null;
    }
    this.playing = false; this._pendingPlay = false;
    var pb = this.el.querySelector('.tk-play-btn');
    if (pb) pb.classList.remove('pending');
    this._updatePlayBtn(false);
  }
  stop() { this._fadeStop(); }

  _xfade(newOff, scheduledAt) {
    if (!this.buffer) return;
    var ctx = SN.AudioEngine.ctx;
    var now = scheduledAt || ctx.currentTime, fd = this._FADE;
    if (this.sourceNode) {
      this._srcGain.gain.cancelScheduledValues(now);
      this._srcGain.gain.setValueAtTime(this._srcGain.gain.value, now);
      this._srcGain.gain.exponentialRampToValueAtTime(0.001, now + fd);
      this.sourceNode.stop(now + fd + 0.002); this.sourceNode = null;
    }
    var at = now + fd;
    this._srcGain.gain.setValueAtTime(0.001, at);
    this._srcGain.gain.exponentialRampToValueAtTime(1, at + fd);
    this._startSource(newOff, at);
    this._updatePlayBtn(true);
  }

  _killSource() {
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch(e) {}
      try { this.sourceNode.disconnect(); } catch(e) {}
      this.sourceNode = null;
    }
    this.playing = false;
  }

  _togglePlay() {
    if (this.playing) { this._fadeStop(); return; }
    if (!this.buffer) return;
    SN.AudioEngine.resume();
    if (SN.Transport.playing) {
      this._pendingPlay = true;
      var pb = this.el.querySelector('.tk-play-btn');
      if (pb) pb.classList.add('pending');
    } else this.play();
  }

  _cue() {
    var t = (this.loopActive && this.loopSize) ? this.loopStartBuf : 0;
    if (this.playing) this._xfade(t); else this._offsetAt = t;
    this._jumpBar = -1;
  }

  _updatePlayBtn(on) {
    var b = this.el.querySelector('.tk-play-btn'); if (!b) return;
    b.classList.toggle('playing', on); b.classList.toggle('stopped', !on);
    b.innerHTML = on ? '&#9646;&#9646;' : '&#9654;';
  }

  /* ═══ TRANSPORT STEP ═══ */

  _onStep(step, time) {
    var isBar = (step % 16 === 0);

    if (this._pendingPlay && isBar) {
      this._pendingPlay = false;
      var pb = this.el.querySelector('.tk-play-btn');
      if (pb) pb.classList.remove('pending');
      this._offsetAt = this._snapBar(this._offsetAt);
      this.play(time);
    }

    if (step >= 0) {
      // Gate seq a 1/8: avanza un gate step cada 2 transport steps.
      // 16 botones × 2 = 32 transport steps = 1 ciclo completo de transport.
      var isNewGateStep = (step % 2 === 0);
      if (isNewGateStep) {
        var gateIdx = (step / 2) % 16;
        this._highlightGateStep(gateIdx);
        if (this.gateActive && this.playing) {
          var open = this.gateSteps[gateIdx];
          // opening → attack, closing → release
          var tc = (open ? this.gateAtkMs : this.gateRelMs) / 3000;
          this.gateGain.gain.setTargetAtTime(open ? 1 : 0, time, Math.max(0.0003, tc));
          this._gateOpen = open;
        }
      }
    }

    if (!this.playing) return;

    /* bar jump — DON'T TOUCH, works perfectly */
    if (this._jumpBar >= 0 && isBar) {
      var target = this._barStart(this._jumpBar);
      this._jumpBar = -1;
      this._xfade(target, time);
      return;
    }

    /* PENDING LOOP: activate at boundary */
    if (this._pendingLoop) {
      var q = this._loopQuantum();
      if (step % q === 0) {
        this._doActivateLoop(time);
        return;
      }
    }

    /* RE-SYNC at bar boundaries — ONLY when NOT looping */
    if (isBar && this._barDur > 0 && !this.loopActive) {
      var pos = this._pos();
      var posInBar = ((pos % this._barDur) + this._barDur) % this._barDur;
      var drift = Math.min(posInBar, this._barDur - posInBar);
      if (drift > this._16thDur * 0.5) {
        var nearBar = Math.round(pos / this._barDur);
        var corrected = SN.Utils.clamp(nearBar * this._barDur, 0, this.buffer.duration - 0.001);
        console.log('[Deck ' + this.deckId + '] RESYNC drift=' +
          (drift * 1000).toFixed(1) + 'ms -> bar ' + nearBar);
        this._xfade(corrected, time);
      }
    }
  }

  /* ═══════════════════════════════════════════
     LOOP v12 — CLEAN SEPARATION

     .tk-loop-toggle = ON/OFF button
     .tk-loop-btn    = SIZE only (8,4,2,1,1/4,1/8,1/16)

     ACTIVATE:
       1. Press LOOP toggle → _pendingLoop = true, blink
       2. _onStep: step % quantum === 0 → _doActivateLoop(time)
       3. pos = where we are NOW (the boundary)
       4. END = snap(pos), START = END - loopSize*barDur
       5. _xfade(START, time) — new source with loop bounds

     DEACTIVATE:
       1. Press LOOP toggle → grab _pos(), set loopActive=false
       2. _xfade(pos) — new source WITHOUT loop bounds
       3. Bar-boundary resync catches any drift on next bar

     SIZE CHANGE:
       - If not looping: just store the value
       - If looping: recalculate bounds around current pos, xfade
     ═══════════════════════════════════════════ */

  _initLoopBtns() {
    var self = this;

    /* TOGGLE BUTTON */
    var tog = this.el.querySelector('.tk-loop-toggle');
    if (tog) tog.addEventListener('click', function() { self._toggleLoop(); });

    /* SIZE BUTTONS — ONLY change size */
    var c = this.el.querySelector('.tk-loop-btns');
    if (c) c.querySelectorAll('.tk-loop-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { self._setLoopSize(+btn.dataset.loop); });
    });

    /* SHIFT BUTTONS */
    var left = this.el.querySelector('.tk-loop-left');
    if (left) left.addEventListener('click', function() { self._loopShift(-1); });
    var right = this.el.querySelector('.tk-loop-right');
    if (right) right.addEventListener('click', function() { self._loopShift(1); });

    this._highlightSizeBtn();
  }

  _toggleLoop() {
    if (!this.buffer || !this._barDur) return;
    if (this.loopActive) {
      this._releaseLoop();
    } else if (this._pendingLoop) {
      this._pendingLoop = false;
      this._updateLoopUI();
    } else {
      /* Reset stale bounds so _pos() can't wrap into old loop */
      this.loopStartBuf = 0;
      this.loopEndBuf = 0;

      if (this.playing && SN.Transport.playing) {
        /* Transport running → wait for next boundary via _onStep */
        this._pendingLoop = true;
        this._updateLoopUI();
        console.log('[Deck ' + this.deckId + '] LOOP pending sz=' + this.loopSize + ' q=' + this._loopQuantum());
      } else {
        /* Not playing or transport stopped → activate immediately */
        this._doActivateLoop(SN.AudioEngine.ctx.currentTime);
      }
    }
  }

  /** Called from _onStep at boundary */
  _doActivateLoop(time) {
    this._pendingLoop = false;

    /* CRITICAL: get pos BEFORE loopActive=true,
       otherwise _pos() wraps into OLD loop bounds.
       Also ensure bounds are zeroed so they can't interfere. */
    this.loopStartBuf = 0;
    this.loopEndBuf = 0;
    var pos = this._pos();
    pos = SN.Utils.clamp(pos, 0, this.buffer.duration - 0.001);

    this.loopActive = true;
    var loopDurBuf = this.loopSize * this._barDur;

    /* Snap to grid matching loop size */
    var grid = (this.loopSize >= 1) ? this._barDur : (this.loopSize * this._barDur);
    var snapped = Math.round(pos / grid) * grid;

    /* END = boundary we just hit, START = END - size */
    this.loopEndBuf = SN.Utils.clamp(snapped, loopDurBuf, this.buffer.duration);
    this.loopStartBuf = Math.max(0, this.loopEndBuf - loopDurBuf);

    this._updateLoopUI();

    /* Jump to loop START — synced to transport time */
    if (this.playing) this._xfade(this.loopStartBuf, time);

    console.log('[Deck ' + this.deckId + '] LOOP ON ' + this.loopSize + 'bar pos=' + pos.toFixed(3) +
      ' [' + this.loopStartBuf.toFixed(3) + '-' + this.loopEndBuf.toFixed(3) + ']');
  }

  /** Release: just continue from where you are */
  _releaseLoop() {
    /* Grab pos WHILE loopActive is still true */
    var pos = this._pos();

    /* Clear ALL loop state */
    this.loopActive = false;
    this._pendingLoop = false;
    this.loopStartBuf = 0;
    this.loopEndBuf = 0;
    this._updateLoopUI();

    /* Restart source without loop bounds */
    if (this.playing && this.sourceNode) {
      this._xfade(pos);
      /* Force re-anchor _startedAt so _pos() is clean for next loop */
      var now = SN.AudioEngine.ctx.currentTime;
      this._startedAt = now - pos / this._rate();
    }

    console.log('[Deck ' + this.deckId + '] LOOP OFF pos=' + pos.toFixed(3));
  }

  _setLoopSize(sz) {
    this.loopSize = sz;
    this._highlightSizeBtn();

    if (this._pendingLoop) {
      /* Just update quantum — pending will use new size */
      console.log('[Deck ' + this.deckId + '] LOOP size -> ' + sz + ' (pending)');
      return;
    }

    if (this.loopActive && this.buffer && this._barDur) {
      /* Recalculate bounds around current position */
      var pos = this._pos();
      var loopDurBuf = sz * this._barDur;
      var startGrid = Math.floor(pos / loopDurBuf) * loopDurBuf;
      this.loopStartBuf = Math.max(0, startGrid);
      this.loopEndBuf = Math.min(this.loopStartBuf + loopDurBuf, this.buffer.duration);

      if (this.playing) {
        var newPos = (pos >= this.loopStartBuf && pos < this.loopEndBuf) ? pos : this.loopStartBuf;
        this._xfade(newPos);
      }
      console.log('[Deck ' + this.deckId + '] LOOP resize ' + sz + 'bar [' +
        this.loopStartBuf.toFixed(3) + '-' + this.loopEndBuf.toFixed(3) + ']');
    }
  }

  _loopShift(dir) {
    if (!this.loopActive || !this.buffer) return;
    var len = this.loopEndBuf - this.loopStartBuf;
    var ns = this.loopStartBuf + len * dir;
    /* Snap to 16th-note grid */
    ns = Math.round(ns / this._16thDur) * this._16thDur;
    ns = SN.Utils.clamp(ns, 0, this.buffer.duration - len);
    this.loopStartBuf = ns;
    this.loopEndBuf = Math.min(ns + len, this.buffer.duration);
    /* xfade to new loop start — always restart source for clean bounds */
    if (this.playing) this._xfade(this.loopStartBuf);
    console.log('[Deck ' + this.deckId + '] LOOP shift [' +
      this.loopStartBuf.toFixed(3) + '-' + this.loopEndBuf.toFixed(3) + ']');
  }

  _highlightSizeBtn() {
    var sz = this.loopSize;
    this.el.querySelectorAll('.tk-loop-btn').forEach(function(b) {
      b.classList.toggle('selected', +b.dataset.loop === sz);
    });
  }

  _updateLoopUI() {
    var tog = this.el.querySelector('.tk-loop-toggle');
    if (tog) {
      tog.classList.remove('active', 'pending');
      if (this.loopActive) { tog.classList.add('active'); tog.textContent = 'LOOP ON'; }
      else if (this._pendingLoop) { tog.classList.add('pending'); tog.textContent = 'PEND'; }
      else { tog.textContent = 'LOOP'; }
    }
  }

  _loopLabel() {
    var labels = {8:'8',4:'4',2:'2',1:'1',0.25:'\u00bc',0.125:'\u215b',0.0625:'1/16'};
    return (labels[this.loopSize] || '') + ' BAR';
  }

  /* ═══ WAVEFORM INPUT — click = select BAR (DON'T TOUCH) ═══ */

  _initWaveformInput() {
    var cv = this.el.querySelector('.tk-waveform'); if (!cv) return;
    var self = this, down = false, sx = 0, sScroll = 0;
    cv.addEventListener('mousedown', function(e) {
      if (!self.buffer) return;
      down = true; sx = e.clientX; sScroll = self._userScrollOffset; e.preventDefault();
    });
    window.addEventListener('mousemove', function(e) {
      if (!down || !self.buffer) return;
      var r = cv.getBoundingClientRect(), vw = self._viewWin();
      self._userScrollOffset = sScroll - ((e.clientX - sx) / r.width) * vw.dur;
      self._isUserScrolling = true; clearTimeout(self._scrollTimer);
    });
    window.addEventListener('mouseup', function(e) {
      if (!down) return;
      var dx = Math.abs(e.clientX - sx); down = false;
      if (dx < 5) {
        var r = cv.getBoundingClientRect(), vw = self._viewWin();
        var clickBuf = vw.s + ((e.clientX - r.left) / r.width) * vw.dur;
        var clickBar = self._barAt(SN.Utils.clamp(clickBuf, 0, self.buffer.duration - 0.001));
        if (self.playing) { self._jumpBar = clickBar; }
        else { self._offsetAt = self._barStart(clickBar); }
        self._userScrollOffset = 0; self._isUserScrolling = false;
      } else {
        self._scrollTimer = setTimeout(function() {
          self._isUserScrolling = false; self._userScrollOffset = 0;
        }, 3000);
      }
    });
  }

  /* ═══ WAVEFORM RENDERING ═══ */

  _viewWin() {
    if (!this.buffer) return { s: 0, e: 10, dur: 10 };
    var d = this.buffer.duration, span = this._barDur > 0 ? this._zoomBars * this._barDur : 16;
    var p = this._pos();
    var c = this._isUserScrolling ? p + this._userScrollOffset : p;
    var s = c - span * 0.2, e = c + span * 0.8;
    if (s < 0) { e -= s; s = 0; }
    if (e > d) { s -= (e - d); e = d; }
    s = Math.max(0, s);
    return { s: s, e: e, dur: e - s };
  }

  _startRAF() {
    var self = this;
    (function tick() { self._rafId = requestAnimationFrame(tick); self._draw(); })();
  }

  _draw() {
    var cv = this.el.querySelector('.tk-waveform'); if (!cv) return;
    /* V2: canvas backing store follows its (now larger) CSS size, HiDPI */
    var dpr = window.devicePixelRatio || 1;
    var cw = Math.max(1, Math.round(cv.clientWidth * dpr)), ch = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = cv.width / dpr, H = cv.height / dpr, mid = H / 2;
    if (!this._cachedAccent)
      this._cachedAccent = getComputedStyle(this.el).getPropertyValue('--ch-accent').trim() || '#00ddff';
    var ac = this._cachedAccent;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(8,8,14,0.95)'; g.fillRect(0, 0, W, H);
    if (!this._waveHi || !this.buffer) {
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
      this._updateTime(0, 0, 0, 0); return;
    }
    var dur = this.buffer.duration, vw = this._viewWin(), pos = this._pos();
    var pps = this._waveHi.length / dur;
    var t2x = function(t) { return ((t - vw.s) / vw.dur) * W; };
    var beatDur = this._barDur / 4;

    /* loop region */
    if (this.loopActive && this.loopSize) {
      var lx = t2x(this.loopStartBuf), rx = t2x(this.loopEndBuf);
      g.fillStyle = 'rgba(0,0,0,0.4)';
      if (lx > 0) g.fillRect(0, 0, lx, H);
      if (rx < W) g.fillRect(rx, 0, W - rx, H);
      g.fillStyle = ac + '18';
      g.fillRect(Math.max(0,lx), 0, Math.min(W,rx) - Math.max(0,lx), H);
      g.strokeStyle = ac; g.lineWidth = 2;
      g.beginPath(); g.moveTo(lx, 0); g.lineTo(lx, H); g.moveTo(rx, 0); g.lineTo(rx, H); g.stroke();
      g.fillStyle = ac; g.font = 'bold 9px JetBrains Mono'; g.textAlign = 'center';
      g.fillText(this._loopLabel(), SN.Utils.clamp((lx + rx) / 2, 24, W - 24), 10);
    }
    /* jump marker */
    if (this._jumpBar >= 0) {
      var js = t2x(this._barStart(this._jumpBar));
      var je = t2x(this._barStart(this._jumpBar + 1));
      if (je >= 0 && js <= W) {
        g.fillStyle = 'rgba(255,255,0,0.12)';
        g.fillRect(Math.max(0,js), 0, Math.min(W,je) - Math.max(0,js), H);
        g.strokeStyle = '#ff0'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(js, 0); g.lineTo(js, H); g.stroke();
        g.fillStyle = '#ff0'; g.font = 'bold 8px JetBrains Mono'; g.textAlign = 'left';
        g.fillText('BAR ' + (this._jumpBar + 1), Math.max(2, js + 2), 10);
      }
    }
    /* beat/bar markers */
    if (beatDur > 0) {
      var fb = Math.max(0, Math.floor(vw.s / beatDur)), lb = Math.ceil(vw.e / beatDur);
      for (var i = fb; i <= lb; i++) {
        var bx = t2x(i * beatDur);
        if (bx < -2 || bx > W + 2) continue;
        var isBarLine = (i % 4 === 0);
        g.strokeStyle = isBarLine ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.12)';
        g.lineWidth = isBarLine ? 1.5 : 0.5;
        g.beginPath(); g.moveTo(bx, 0); g.lineTo(bx, H); g.stroke();
        if (isBarLine) {
          g.fillStyle = 'rgba(255,255,255,0.3)'; g.font = '7px JetBrains Mono'; g.textAlign = 'center';
          g.fillText(String(i / 4 + 1), bx, H - 2);
        }
      }
    }
    /* waveform */
    var i0 = Math.max(0, Math.floor(vw.s * pps));
    var i1 = Math.min(this._waveHi.length - 1, Math.floor(vw.e * pps));
    var ir = i1 - i0;
    if (ir > 0) {
      var px0 = t2x(pos);
      for (var pass = 0; pass < 2; pass++) {
        var xS = pass === 0 ? 0 : Math.max(0, Math.floor(px0));
        var xE = pass === 0 ? Math.max(0, Math.floor(px0)) : W;
        if (xS >= xE) continue;
        g.beginPath(); g.strokeStyle = pass === 0 ? 'rgba(255,255,255,0.15)' : ac;
        g.globalAlpha = pass === 0 ? 1 : 0.85; g.lineWidth = 1;
        for (var px = xS; px < xE; px++) {
          var idx = Math.floor(i0 + (px / W) * ir);
          if (idx < 0 || idx >= this._waveHi.length) continue;
          g.moveTo(px, mid - this._waveHi[idx] * mid);
          g.lineTo(px, mid - this._waveLo[idx] * mid);
        }
        g.stroke(); g.globalAlpha = 1;
      }
      if (px0 >= -2 && px0 <= W + 2) {
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.shadowColor = '#fff'; g.shadowBlur = 6;
        g.beginPath(); g.moveTo(px0, 0); g.lineTo(px0, H); g.stroke(); g.shadowBlur = 0;
        g.fillStyle = '#fff'; g.beginPath();
        g.moveTo(px0 - 4, 0); g.lineTo(px0 + 4, 0); g.lineTo(px0, 5); g.closePath(); g.fill();
      }
    }
    this._updateTime(pos, dur, this._barAt(pos), this._stepInBar(pos));
  }

  _updateTime(pos, dur, curBar, curStep) {
    var rate = this._rate(), rp = rate > 0 ? pos / rate : 0, rd = rate > 0 ? dur / rate : 0;
    var te = this.el.querySelector('.tk-time');
    if (te) { var m = Math.floor(rp/60), s = Math.floor(rp%60), ms = Math.floor((rp%1)*100);
      te.textContent = m+':'+String(s).padStart(2,'0')+'.'+String(ms).padStart(2,'0'); }
    var re = this.el.querySelector('.tk-remaining');
    if (re && rd > 0) { var r = Math.max(0, rd - rp);
      re.textContent = '-'+Math.floor(r/60)+':'+String(Math.floor(r%60)).padStart(2,'0'); }
    var bi = this.el.querySelector('.tk-bar-info');
    if (bi && this.buffer) bi.textContent = 'B'+(curBar+1)+'/'+this.totalBars+' S'+(curStep+1);
  }

  _onKnob(p, v) {
    var t = SN.AudioEngine.ctx.currentTime;
    switch (p) {
      case 'tkHpf': if (this.hpfActive) this.hpf.frequency.setTargetAtTime(v, t, 0.02); break;
      case 'tkLpf': if (this.lpfActive) this.lpf.frequency.setTargetAtTime(v, t, 0.02); break;
      case 'tkSendDly':  this.sendGain.gain.setTargetAtTime(v, t, 0.02); break;
      case 'tkSendRev':  this.sendRevGain.gain.setTargetAtTime(v, t, 0.02); break;
      case 'tkSendDist': this.sendDistGain.gain.setTargetAtTime(v, t, 0.02); break;
      case 'gateAtk': this.gateAtkMs = v; break;
      case 'auxSend': if (this.aux) this.aux.setLevel(v); break;
      case 'gateRel': this.gateRelMs = v; break;
    }
  }

  onBPMChange() {
    if (this.buffer && this._barDur && this.sourceNode && this.playing) this._applyRate();
  }

  globalStop() {
    this._fadeStop(); this._offsetAt = 0;
    this._pendingPlay = false; this._jumpBar = -1;
    this._pendingLoop = false; this.loopActive = false;
    this._updateLoopUI();
    this.gateGain.gain.setTargetAtTime(1, SN.AudioEngine.ctx.currentTime, 0.002);
  }
};
