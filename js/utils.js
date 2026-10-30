/* ═══════════════════════════════════════════
   UTILS — BPM calculations, conversions
   ═══════════════════════════════════════════ */

const SN = window.SN || {};
window.SN = SN;

SN.Utils = {
  /**
   * Duration of N bars of 4/4 at given BPM (seconds)
   */
  barsDuration(bars, bpm) {
    return (bars * 4 * 60) / bpm;
  },

  /**
   * Time-stretch ratio: how much to speed/slow a sample
   * sampleDuration = actual length in seconds
   * targetDuration = desired length for N bars at BPM
   */
  stretchRatio(sampleDuration, bars, bpm) {
    const target = this.barsDuration(bars, bpm);
    return sampleDuration / target;
  },

  /**
   * Pitch semitones to playback rate multiplier
   */
  semitonesToRate(semitones) {
    return Math.pow(2, semitones / 12);
  },

  /**
   * Delay time in ms for a beat subdivision at given BPM
   */
  delayTimeForDivision(division, bpm) {
    const quarterMs = 60000 / bpm;
    switch (division) {
      case '1/4':   return quarterMs;
      case '1/4T':  return quarterMs * (2 / 3);
      case '1/8':   return quarterMs / 2;
      case '1/8T':  return (quarterMs / 2) * (2 / 3);
      case '1/16':  return quarterMs / 4;
      case '1/16T': return (quarterMs / 4) * (2 / 3);
      default:      return null; // free mode
    }
  },

  /**
   * Duration of one 16th note in seconds
   */
  sixteenthDuration(bpm) {
    return 15 / bpm; // (60 / bpm) / 4
  },

  /**
   * Generate sample file list: 01.wav to 20.wav
   */
  sampleList(folder) {
    const list = [];
    for (let i = 1; i <= 20; i++) {
      const num = String(i).padStart(2, '0');
      list.push({ name: `${num}`, url: `samples/${folder}/${num}.mp3` });
    }
    return list;
  },

  /**
   * Clamp a value between min and max
   */
  clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  },

  /**
   * Map a 0-1 normalized value to a range
   */
  mapRange(norm, min, max) {
    return min + norm * (max - min);
  },

  /**
   * Inverse: map value in range to 0-1
   */
  normRange(val, min, max) {
    return (val - min) / (max - min);
  },

  /**
   * Format frequency for display
   */
  formatFreq(hz) {
    if (hz >= 1000) return (hz / 1000).toFixed(1) + 'k Hz';
    return Math.round(hz) + ' Hz';
  },

  /**
   * dB gain to linear
   */
  dbToLinear(db) {
    return Math.pow(10, db / 20);
  },

  /**
   * V2 — MUTE button binding (post-fader mute: kills main out + sends)
   * getNode() returns the GainNode to mute (function so rebuilds keep working)
   */
  bindMute(btn, getNode) {
    if (!btn) return null;
    const state = { muted: false, _cbs: [] };
    const apply = () => {
      const node = getNode();
      if (node) node.gain.setTargetAtTime(state.muted ? 0 : 1, SN.AudioEngine.ctx.currentTime, 0.006);
      btn.classList.toggle('active', state.muted);
      state._cbs.forEach(fn => fn(state.muted));
    };
    state.onChange = (fn) => state._cbs.push(fn);   // V2.8 (AUX PRE follows MUTE)
    btn.addEventListener('click', () => { state.muted = !state.muted; apply(); });
    state.set = (m) => { state.muted = !!m; apply(); };
    return state;
  }
};
