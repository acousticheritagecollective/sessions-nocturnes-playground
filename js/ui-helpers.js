/* ═══════════════════════════════════════════
   UI HELPERS — LEDs, output selector, misc
   ═══════════════════════════════════════════ */

SN.UI = {
  _stepLeds: [],

  init() {
    this._buildStepLeds();
    this._initOutputSelector();
    this._initVerticalFaders();
  },

  /* ─── VERTICAL FADERS (V2.1) ───
     Los faders son <input type=range> girados -90° con CSS. Algunos
     navegadores/sistemas (p.ej. Windows) siguen interpretando el arrastre
     en horizontal. Aquí el arrastre se calcula nosotros a partir de la
     posición VERTICAL del puntero sobre la caja visible del fader, así
     funciona igual en todas partes. Se sigue emitiendo el evento 'input'
     de siempre (audio y MIDI learn no cambian). */
  _initVerticalFaders() {
    const THUMB = 14; // largo del thumb a lo largo del recorrido (px)
    document.querySelectorAll('.channel-fader').forEach(fader => {
      if (fader._snVertical) return;
      fader._snVertical = true;

      const min = () => parseFloat(fader.min || 0);
      const max = () => parseFloat(fader.max || 1);
      const step = () => parseFloat(fader.step || 0.01);

      const valueFromY = (y) => {
        const r = fader.getBoundingClientRect();
        const usable = Math.max(1, r.height - THUMB);
        const f = 1 - (y - r.top - THUMB / 2) / usable;
        return min() + Math.max(0, Math.min(1, f)) * (max() - min());
      };
      const thumbY = () => {
        const r = fader.getBoundingClientRect();
        const f = (parseFloat(fader.value) - min()) / (max() - min());
        return r.top + THUMB / 2 + (1 - f) * (r.height - THUMB);
      };
      const setValue = (v) => {
        const s = step();
        v = Math.round(v / s) * s;
        v = Math.max(min(), Math.min(max(), v));
        const str = String(+v.toFixed(4));
        if (fader.value !== str) {
          fader.value = str;
          fader.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };

      let dragging = false, grabOffset = 0, pid = null;

      fader.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;          // right-click = MIDI learn
        e.preventDefault();
        dragging = true;
        pid = e.pointerId;
        try { fader.setPointerCapture(pid); } catch (err) {}
        // Agarrar el thumb no salta; clicar en el recorrido salta ahí (como antes)
        const ty = thumbY();
        grabOffset = Math.abs(e.clientY - ty) <= 14 ? (e.clientY - ty) : 0;
        setValue(valueFromY(e.clientY - grabOffset));
        document.body.style.cursor = 'grabbing';
      });
      fader.addEventListener('pointermove', (e) => {
        if (!dragging || e.pointerId !== pid) return;
        e.preventDefault();
        setValue(valueFromY(e.clientY - grabOffset));
      });
      const end = (e) => {
        if (!dragging || (e && e.pointerId !== pid)) return;
        dragging = false;
        try { fader.releasePointerCapture(pid); } catch (err) {}
        pid = null;
        document.body.style.cursor = '';
      };
      fader.addEventListener('pointerup', end);
      fader.addEventListener('pointercancel', end);
      fader.addEventListener('lostpointercapture', end);

      // Bloquear el arrastre nativo (horizontal en algunos sistemas)
      fader.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
      fader.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

      // Rueda del ratón: arriba = sube
      fader.addEventListener('wheel', (e) => {
        e.preventDefault();
        setValue(parseFloat(fader.value) + (e.deltaY < 0 ? 1 : -1) * step() * 2);
      }, { passive: false });
    });
  },

  _buildStepLeds() {
    const container = document.getElementById('step-leds');
    if (!container) return;
    container.innerHTML = '';

    for (let i = 0; i < 32; i++) {
      const led = document.createElement('div');
      led.className = 'step-led';
      if (i % 4 === 0) led.classList.add('beat');
      if (i > 0 && i % 8 === 0) led.style.marginLeft = '4px';
      container.appendChild(led);
      this._stepLeds.push(led);
    }

    // Register step callback for LED updates
    SN.Transport.onStep((step) => this._updateLeds(step));
  },

  _updateLeds(step) {
    this._stepLeds.forEach((led, i) => {
      led.classList.toggle('active', i === step);
    });
  },

  async _initOutputSelector() {
    const select = document.getElementById('audio-output');
    if (!select) return;

    try {
      const devices = await SN.AudioEngine.getOutputDevices();
      if (devices.length > 0) {
        select.innerHTML = '';
        devices.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Output ${d.deviceId.slice(0, 8)}`;
          select.appendChild(opt);
        });
      }
    } catch (e) {
      console.warn('[UI] Could not list outputs');
    }

    select.addEventListener('change', () => {
      SN.AudioEngine.setOutputDevice(select.value);
    });
  },

  /**
   * Flash a CSS class on an element briefly
   */
  flash(el, className, ms) {
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), ms || 150);
  }
};
