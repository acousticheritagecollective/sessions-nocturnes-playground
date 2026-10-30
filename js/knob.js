/* ═══════════════════════════════════════════
   KNOB — SVG rotary control component
   ═══════════════════════════════════════════ */

SN.Knob = class Knob {
  constructor(element, onChange) {
    this.el = element;
    this.onChange = onChange || (() => {});
    this.param = element.dataset.param;
    this.min = parseFloat(element.dataset.min);
    this.max = parseFloat(element.dataset.max);
    this.value = parseFloat(element.dataset.value);

    // Rotation range: -135deg to +135deg (270 total)
    this.startAngle = -135;
    this.endAngle = 135;
    this.rangeAngle = 270;

    this._dragging = false;
    this._startY = 0;
    this._startValue = 0;

    this._build();
    this._bind();
    this._render();
  }

  _build() {
    const size = this.el.classList.contains('knob-lg') ? 56 : 44;
    const r = size / 2;
    const trackR = r - 6;

    this.el.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('class', 'knob-svg');

    // Background circle
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bg.setAttribute('cx', r);
    bg.setAttribute('cy', r);
    bg.setAttribute('r', trackR);
    bg.setAttribute('class', 'knob-center');
    svg.appendChild(bg);

    // Track arc
    this._trackPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this._trackPath.setAttribute('class', 'knob-track-arc');
    this._trackPath.setAttribute('d', this._arcPath(r, trackR, this.startAngle, this.endAngle));
    svg.appendChild(this._trackPath);

    // Fill arc
    this._fillPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this._fillPath.setAttribute('class', 'knob-fill-arc');
    svg.appendChild(this._fillPath);

    // Pointer line
    this._pointer = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    this._pointer.setAttribute('class', 'knob-pointer-line');
    svg.appendChild(this._pointer);

    // Value text
    this._valueText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    this._valueText.setAttribute('class', 'knob-value-text');
    this._valueText.setAttribute('x', r);
    this._valueText.setAttribute('y', r + 3);
    svg.appendChild(this._valueText);

    this.el.appendChild(svg);
    this._r = r;
    this._trackR = trackR;
  }

  _bind() {
    // Mouse
    this.el.addEventListener('mousedown', (e) => this._onStart(e.clientY, e));
    window.addEventListener('mousemove', (e) => { if (this._dragging) this._onMove(e.clientY); });
    window.addEventListener('mouseup', () => this._onEnd());

    // Touch
    this.el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._onStart(e.touches[0].clientY, e);
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      if (this._dragging) this._onMove(e.touches[0].clientY);
    }, { passive: false });
    window.addEventListener('touchend', () => this._onEnd());

    // Double click to reset
    this.el.addEventListener('dblclick', () => {
      this.value = parseFloat(this.el.dataset.value);
      this._render();
      this.onChange(this.param, this.value);
    });
  }

  _onStart(y, e) {
    e.stopPropagation();
    this._dragging = true;
    this._startY = y;
    this._startValue = this.value;
    document.body.style.cursor = 'grabbing';
  }

  _onMove(y) {
    const delta = this._startY - y;
    const sensitivity = (this.max - this.min) / 200;
    let newVal = this._startValue + delta * sensitivity;
    // Snap to integers for pitch
    if (this.param === 'pitch' || this.param === 'kickPitch' || this.param === 'synthNote' || this.param === 'snarePitch' || this.param === 'kickSel') {
      newVal = Math.round(newVal);
    }
    this.value = SN.Utils.clamp(newVal, this.min, this.max);
    this._render();
    this.onChange(this.param, this.value);
  }

  _onEnd() {
    if (!this._dragging) return;
    this._dragging = false;
    document.body.style.cursor = '';
  }

  _render() {
    const norm = SN.Utils.normRange(this.value, this.min, this.max);
    const angle = this.startAngle + norm * this.rangeAngle;
    const r = this._r;
    const tr = this._trackR;

    // Determine fill direction based on param type
    let fillStart, fillEnd;
    if (this.min < 0 && this.max > 0) {
      // Bipolar: fill from center
      const centerAngle = this.startAngle + SN.Utils.normRange(0, this.min, this.max) * this.rangeAngle;
      fillStart = Math.min(centerAngle, angle);
      fillEnd = Math.max(centerAngle, angle);
    } else {
      fillStart = this.startAngle;
      fillEnd = angle;
    }

    this._fillPath.setAttribute('d', this._arcPath(r, tr, fillStart, fillEnd));

    // Pointer
    const rad = (angle - 90) * Math.PI / 180;
    const innerR = tr * 0.35;
    const outerR = tr * 0.85;
    this._pointer.setAttribute('x1', r + innerR * Math.cos(rad));
    this._pointer.setAttribute('y1', r + innerR * Math.sin(rad));
    this._pointer.setAttribute('x2', r + outerR * Math.cos(rad));
    this._pointer.setAttribute('y2', r + outerR * Math.sin(rad));

    // Value display
    this._valueText.textContent = this._formatValue();
  }

  _formatValue() {
    const v = this.value;
    if (this.param === 'pitch' || this.param === 'kickPitch' || this.param === 'snarePitch') return (v > 0 ? '+' : '') + Math.round(v);
    if (this.param === 'snareHpf' || this.param === 'snareLpf') return SN.Utils.formatFreq(v);
    if (this.param === 'snareMid') return (v > 0 ? '+' : '') + v.toFixed(0) + 'dB';
    if (this.param === 'synthNote') {
      const notes = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      const n = Math.round(v);
      return notes[n % 12] + Math.floor(n / 12 - 1);
    }
    if (this.param === 'synthCutoff') return SN.Utils.formatFreq(v);
    if (this.param === 'synthReso') return v.toFixed(1);
    if (this.param === 'synthA' || this.param === 'synthD' || this.param === 'synthR') {
      return v < 0.1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's';
    }
    if (this.param === 'synthS') return Math.round(v * 100);
    if (this.param === 'delayTime') return Math.round(v) + 'ms';
    if (this.param === 'reverbDecay') return v.toFixed(1) + 's';
    if (this.param === 'reverbDamp' || this.param === 'distTone') return SN.Utils.formatFreq(v);
    if (this.param === 'distDrive') return Math.round(v);
    if (this.param === 'hpfFreq' || this.param === 'lpfFreq') return SN.Utils.formatFreq(v);
    if (this.param === 'delayFeedback') return Math.round(v * 100) + '%';
    if (this.param === 'cueLevel' || this.param === 'auxLevel') return Math.round(v * 100);
    if (this.param === 'kickSel') { const n = Math.round(v); return n === 0 ? 'OFF' : String(n).padStart(2, '0'); }
    if (this.param === 'limThresh') return v.toFixed(1) + 'dB';
    if (this.param === 'limRelease') return Math.round(v) + 'ms';
    if (this.param === 'gateAtk' || this.param === 'gateRel') return Math.round(v) + 'ms';
    if (v >= 0 && v <= 1) return Math.round(v * 100);
    if (this.param?.startsWith('eq')) return (v > 0 ? '+' : '') + v.toFixed(0) + 'dB';
    return v.toFixed(1);
  }

  _arcPath(center, radius, startDeg, endDeg) {
    if (Math.abs(endDeg - startDeg) < 0.1) return '';
    const startRad = (startDeg - 90) * Math.PI / 180;
    const endRad = (endDeg - 90) * Math.PI / 180;
    const x1 = center + radius * Math.cos(startRad);
    const y1 = center + radius * Math.sin(startRad);
    const x2 = center + radius * Math.cos(endRad);
    const y2 = center + radius * Math.sin(endRad);
    const largeArc = (endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
  }

setValue(v) {
  this.value = SN.Utils.clamp(v, this.min, this.max);
  this._render();
  this.onChange(this.param, this.value);
}

  getValue() {
    return this.value;
  }
};
