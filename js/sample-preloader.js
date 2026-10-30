/* ═══════════════════════════════════════════
   SAMPLE PRELOADER — Boot-time audio cache
   Scans all select elements for sample URLs,
   fetches + decodes them all into SN.SampleCache
   so runtime loads are instant (0 latency).
   ═══════════════════════════════════════════ */

SN.SamplePreloader = {
  // Config
  _concurrency: 6,        // parallel fetches (sweet spot: 6-8)

  // State
  _overlay: null,
  _barFill: null,
  _countEl: null,
  _fileEl: null,
  _titleEl: null,
  _subtitleEl: null,
  _skipBtn: null,

  _total: 0,
  _done: 0,
  _failed: 0,
  _cancelled: false,

  /* ─── Public API ─── */

  async run() {
    this._createOverlay();
    this._show();

    const urls = this.collectURLs();
    this._total = urls.length;
    this._done = 0;
    this._failed = 0;
    this._cancelled = false;

    if (this._total === 0) {
      console.log('[Preloader] No URLs to preload');
      this._hide();
      return;
    }

    console.log('[Preloader] Starting preload of', this._total, 'files');
    this._setTitle('LOADING SAMPLES');
    this._setSubtitle('Preparing for live session…');
    this._updateProgress();

    const startedAt = performance.now();
    await this._runPool(urls);
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);

    console.log('[Preloader] Done:', this._done, 'cached,', this._failed, 'missing,', elapsed + 's');

    // Brief "ready" flash
    this._setTitle('READY');
    this._setSubtitle(
      this._done + ' samples cached · ' +
      (this._failed > 0 ? this._failed + ' missing · ' : '') +
      elapsed + 's'
    );
    if (this._fileEl) this._fileEl.textContent = '';

    await new Promise(r => setTimeout(r, 550));
    this._hide();
  },

  /* Collect every sample URL from populated selects */
  collectURLs() {
    const set = new Set();

    // Channel loops (.loop-select) — includes kick sample select
    document.querySelectorAll('.loop-select option').forEach(opt => {
      if (opt.value && opt.value.indexOf('samples/') === 0) set.add(opt.value);
    });

    // Track decks
    document.querySelectorAll('.tk-track-select option').forEach(opt => {
      if (opt.value && opt.value.indexOf('samples/') === 0) set.add(opt.value);
    });

    return Array.from(set);
  },

  /* ─── Concurrent pool ─── */

  async _runPool(urls) {
    const queue = urls.slice();
    const workers = [];

    const worker = async () => {
      while (queue.length > 0 && !this._cancelled) {
        const url = queue.shift();
        await this._loadOne(url);
      }
    };

    for (let i = 0; i < this._concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  },

  async _loadOne(url) {
    this._setFile(url);
    try {
      const buf = await SN.AudioEngine.loadSample(url);
      if (buf) {
        // V2.2: precompute deck waveform so loading a track mid-set is instant
        if (url.indexOf('samples/tracks/') === 0 && SN.TrackPeaks) await SN.TrackPeaks.compute(url, buf);
        this._done++;
      } else {
        this._failed++;
      }
    } catch (e) {
      this._failed++;
    }
    this._updateProgress();
  },

  /* ─── UI ─── */

  _createOverlay() {
    if (this._overlay) return;

    const ov = document.createElement('div');
    ov.id = 'sample-preloader-overlay';
    ov.className = 'sample-preloader-overlay';
    ov.innerHTML = ''
      + '<div class="spl-box">'
      +   '<div class="spl-title" id="spl-title">LOADING SAMPLES</div>'
      +   '<div class="spl-subtitle" id="spl-subtitle">Preparing for live session…</div>'
      +   '<div class="spl-bar-wrap"><div class="spl-bar-fill" id="spl-bar-fill"></div></div>'
      +   '<div class="spl-row">'
      +     '<span class="spl-count" id="spl-count">0 / 0</span>'
      +     '<span class="spl-file" id="spl-file"></span>'
      +   '</div>'
      +   '<button class="spl-skip" id="spl-skip" title="Skip preload (samples will load on demand)">SKIP</button>'
      + '</div>';

    document.body.appendChild(ov);

    this._overlay    = ov;
    this._titleEl    = ov.querySelector('#spl-title');
    this._subtitleEl = ov.querySelector('#spl-subtitle');
    this._barFill    = ov.querySelector('#spl-bar-fill');
    this._countEl    = ov.querySelector('#spl-count');
    this._fileEl     = ov.querySelector('#spl-file');
    this._skipBtn    = ov.querySelector('#spl-skip');

    this._skipBtn.addEventListener('click', () => {
      this._cancelled = true;
      this._setTitle('SKIPPED');
      this._setSubtitle('Remaining samples will load on demand');
    });
  },

  _show() {
    if (this._overlay) this._overlay.classList.add('spl-visible');
  },

  _hide() {
    if (!this._overlay) return;
    this._overlay.classList.add('spl-fadeout');
    setTimeout(() => {
      this._overlay.classList.remove('spl-visible', 'spl-fadeout');
    }, 400);
  },

  _updateProgress() {
    const processed = this._done + this._failed;
    const pct = this._total > 0 ? (processed / this._total) * 100 : 0;
    if (this._barFill) this._barFill.style.width = pct.toFixed(1) + '%';
    if (this._countEl) this._countEl.textContent = processed + ' / ' + this._total;
  },

  _setFile(url) {
    if (!this._fileEl) return;
    // Show only the last 2 path components for readability
    const parts = url.split('/');
    const short = parts.slice(-2).join('/');
    this._fileEl.textContent = short;
  },

  _setTitle(t)    { if (this._titleEl)    this._titleEl.textContent    = t; },
  _setSubtitle(t) { if (this._subtitleEl) this._subtitleEl.textContent = t; }
};
