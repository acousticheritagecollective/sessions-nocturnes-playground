/* ═══════════════════════════════════════════
   TRANSPORT — BPM clock & scheduler
   Lookahead scheduler pattern
   ═══════════════════════════════════════════ */

SN.Transport = {
  bpm: 127,
  playing: false,
  currentStep: 0,         // 0-31 (16th notes, 4 bars)
  _scheduleAheadTime: 0.05, // seconds to look ahead (50ms — tighter sync)
  _lookaheadMs: 12,         // ms between scheduler calls
  _timerID: null,
  _nextStepTime: 0,        // AudioContext time of next step
  _listeners: [],          // step callbacks

  init(bpm) {
    this.bpm = bpm || 127;
    this.currentStep = 0;
    this.playing = false;
  },

  setBPM(bpm) {
    this.bpm = SN.Utils.clamp(bpm, 60, 200);
  },

  /**
   * Register a callback: fn(step, time) called for each 16th note
   */
  onStep(fn) {
    this._listeners.push(fn);
  },

  removeStep(fn) {
    this._listeners = this._listeners.filter(f => f !== fn);
  },

  play() {
    if (this.playing) return;
    SN.AudioEngine.resume();
    this.playing = true;
    this.currentStep = 0;
    this._nextStepTime = SN.AudioEngine.ctx.currentTime + 0.05;
    this._schedule();
  },

  stop() {
    this.playing = false;
    if (this._timerID !== null) {
      clearTimeout(this._timerID);
      this._timerID = null;
    }
    this.currentStep = 0;
    // Notify listeners of stop
    this._listeners.forEach(fn => fn(-1, 0));
  },

  _schedule() {
    if (!this.playing) return;

    const ctx = SN.AudioEngine.ctx;
    const stepDuration = SN.Utils.sixteenthDuration(this.bpm);

    while (this._nextStepTime < ctx.currentTime + this._scheduleAheadTime) {
      // Fire all listeners for this step
      const step = this.currentStep;
      const time = this._nextStepTime;
      this._listeners.forEach(fn => fn(step, time));

      // Advance
      this._nextStepTime += stepDuration;
      this.currentStep = (this.currentStep + 1) % 32;
    }

    this._timerID = setTimeout(() => this._schedule(), this._lookaheadMs);
  },

  /**
   * Get the AudioContext time of the next beat 1 (step 0)
   */
  getNextDownbeatTime() {
    if (!this.playing) return SN.AudioEngine.ctx.currentTime;
    const stepDuration = SN.Utils.sixteenthDuration(this.bpm);
    const stepsUntilDownbeat = (32 - this.currentStep) % 32;
    return this._nextStepTime + (stepsUntilDownbeat * stepDuration);
  },

  /**
   * Get current playback position as fraction 0-1 within the 16 steps
   */
  getPosition() {
    return this.currentStep / 32;
  }
};
