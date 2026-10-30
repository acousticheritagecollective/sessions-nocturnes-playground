/* ═══════════════════════════════════════════
   MIDI LEARN — Map external MIDI CC to controls
   Right-click any knob/fader/button → move CC → mapped!
   + SAVE / LOAD mappings (JSON file + localStorage auto-restore)
   V2: mappings are per LEARN slot (1-4 = one controller each).
       Key = "slot:ch:cc". Old v1 files/maps load into slot 1.
   ═══════════════════════════════════════════ */

SN.MidiLearn = {
  // State
  enabled: false,
  learning: false,          // currently waiting for CC assignment
  _learningTarget: null,    // { element, type, knobInstance, param }

  // Mappings: key = "slot:ch:cc" → { element, type, knobInstance, param, min, max, slot, channel, cc }
  _mappings: {},

  // All registered learnable controls
  _controls: [],

  // Persistence
  _storageKey: 'snm.midiLearn.mappings.v1',   // same key: v2 data is a superset

  // UI
  _overlay: null,
  _statusEl: null,

  init() {
    this._statusEl = document.getElementById('midi-learn-status');
    this._createOverlay();
    this._initToggle();
    this._registerAllControls();
    this._initSaveLoad();

    // Restore last session mapping automatically
    this._autoLoad();

    console.log('[MidiLearn] Init —', this._controls.length, 'controls registered');
  },

  // ─── REGISTER CONTROLS ───
  _registerAllControls() {
    // Register all SN.Knob instances from SN.App.knobs
    Object.keys(SN.App.knobs).forEach(key => {
      const knob = SN.App.knobs[key];
      if (knob && knob.el) {
        this._controls.push({
          id: 'knob-' + key,
          element: knob.el,
          type: 'knob',
          knobInstance: knob,
          param: key,
          min: parseFloat(knob.el.dataset.min || 0),
          max: parseFloat(knob.el.dataset.max || 1)
        });
      }
    });

    // Track deck knobs & faders
    if (SN.App.trackDecks) {
      SN.App.trackDecks.forEach((deck, idx) => {
        const deckName = ['A', 'B'][idx] || idx;
        if (deck.knobs) {
          Object.keys(deck.knobs).forEach(key => {
            const knob = deck.knobs[key];
            if (knob && knob.el) {
              this._controls.push({
                id: 'deck' + deckName + '-' + key,
                element: knob.el,
                type: 'knob',
                knobInstance: knob,
                param: 'deck' + deckName + '-' + key,
                min: parseFloat(knob.el.dataset.min || 0),
                max: parseFloat(knob.el.dataset.max || 1)
              });
            }
          });
        }
        const fader = deck.el ? deck.el.querySelector('.channel-fader') : null;
        if (fader) {
          this._controls.push({
            id: 'deck' + deckName + '-fader',
            element: fader,
            type: 'fader',
            knobInstance: null,
            param: 'deck' + deckName + '-fader',
            min: parseFloat(fader.min || 0),
            max: parseFloat(fader.max || 1),
            faderEl: fader
          });
        }
      });
    }

    // Kick fader
    const kickFader = document.getElementById('kick-fader');
    if (kickFader) {
      this._controls.push({
        id: 'kick-fader',
        element: kickFader,
        type: 'fader',
        knobInstance: null,
        param: 'kick-fader',
        min: 0, max: 1,
        faderEl: kickFader
      });
    }

    // Ext input channels (V2: 3 channels, knobs now learnable too)
    if (SN.ExtInput && SN.ExtInput.channels) {
      SN.ExtInput.channels.forEach((ch, idx) => {
        const n = idx + 1;
        Object.keys(ch.knobs || {}).forEach(key => {
          const knob = ch.knobs[key];
          if (!knob || !knob.el) return;
          this._controls.push({
            id: 'ext' + n + '-' + key,
            element: knob.el,
            type: 'knob',
            knobInstance: knob,
            param: 'ext' + n + '-' + key,
            min: parseFloat(knob.el.dataset.min || 0),
            max: parseFloat(knob.el.dataset.max || 1)
          });
        });
        const fader = ch.el.querySelector('.channel-fader');
        if (fader) {
          const p = (n === 1) ? 'ext-fader' : ('ext' + n + '-fader'); // keep v1 name for GOMEZ
          this._controls.push({
            id: p, element: fader, type: 'fader', knobInstance: null,
            param: p, min: 0, max: 1, faderEl: fader
          });
        }
      });
    }

    // ─── Buttons (toggles, transport, loop, filters, etc.) ───
    const buttonSelectors = [
      '#hpf-toggle', '#lpf-toggle',
      '#btn-play', '#btn-stop',
      '.tk-loop-toggle', '.tk-loop-btn',
      '.tk-loop-left', '.tk-loop-right',
      '.tk-hpf-toggle', '.tk-lpf-toggle',
      '.tk-play-btn', '.tk-cue-btn',
      '.ch-play-btn', '.gate-toggle',
      '#delay-sync-btns .sync-btn'
    ].join(',');

    // V2: labels stay identical to v1 so saved mapping files keep working.
    // v1 numbered buttons by document order; the 8 buttons of the removed
    // CH01-04 strips sat between DECK B and the EXT IN / delay sync buttons,
    // so those get +8. New buttons get their own stable names below.
    // V2.4: the EXT IN gate was removed too → delay sync buttons get +9.
    const LEGACY_REMOVED = 8;
    const extGateGone = !document.querySelector('#ch06-input .gate-toggle');
    let i = 0;
    document.querySelectorAll(buttonSelectors).forEach((btn) => {
      // gate toggles of the NEW ext channels → stable names (not legacy-indexed)
      const extEl = btn.closest('.ext-ch');
      if (extEl && extEl.id !== 'ch06-input') return;
      // V2.6: the deck CUE button (right before ▶) was removed → keep numbering
      if (btn.classList.contains('tk-play-btn')) i++;
      let legacyIdx = i;
      if (btn.closest('#ch06-input')) legacyIdx = i + LEGACY_REMOVED;
      else if (btn.closest('#delay-sync-btns')) legacyIdx = i + LEGACY_REMOVED + (extGateGone ? 1 : 0);
      i++;
      btn.classList.add('midi-learnable');
      const label = (btn.id || btn.textContent.trim().slice(0, 10) || 'btn') + '-' + legacyIdx;
      this._controls.push({
        id: 'button-' + label,
        element: btn,
        type: 'button',
        knobInstance: null,
        param: label,
        min: 0,
        max: 1
      });
    });

    // V2 buttons with stable names: MUTE (all channels), EXT READY/GATE, LIMITER
    const named = [];
    const deckIds = { ch08a: 'deckA', ch08b: 'deckB' };
    Object.keys(deckIds).forEach(id => {
      const el = document.getElementById(id);
      if (el) named.push([el.querySelector('.ch-mute-btn'), 'mute-' + deckIds[id]]);
    });
    named.push([document.getElementById('kick-mute-btn'), 'mute-kick']);
    // V2.6 MON buttons
    Object.keys(deckIds).forEach(id => {
      const el = document.getElementById(id);
      if (el) named.push([el.querySelector('.ch-mon-btn'), 'mon-' + deckIds[id]]);
    });
    named.push([document.getElementById('kick-mon-btn'), 'mon-kick']);
    // V2.8 AUX PRE/POST
    Object.keys(deckIds).forEach(id => {
      const el = document.getElementById(id);
      if (el) named.push([el.querySelector('.aux-mode-btn'), 'auxmode-' + deckIds[id]]);
    });
    named.push([document.getElementById('kick-aux-mode-btn'), 'auxmode-kick']);
    ['delay', 'reverb', 'dist'].forEach(fx => named.push([document.getElementById(fx + '-aux-mode-btn'), 'auxmode-' + fx]));
    if (SN.ExtInput && SN.ExtInput.channels) {
      SN.ExtInput.channels.forEach((ch, idx) => named.push([ch.el.querySelector('.aux-mode-btn'), 'auxmode-ext' + (idx + 1)]));
    }
    // V2.7 track browse − / LOAD / +
    Object.keys(deckIds).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      named.push([el.querySelector('.tk-browse-prev'), deckIds[id] + '-trackPrev']);
      named.push([el.querySelector('.tk-browse-next'), deckIds[id] + '-trackNext']);
      named.push([el.querySelector('.tk-browse-display'), deckIds[id] + '-trackLoad']);
    });
    if (SN.ExtInput && SN.ExtInput.channels) {
      SN.ExtInput.channels.forEach((ch, idx) => named.push([ch.el.querySelector('.ch-mon-btn'), 'mon-ext' + (idx + 1)]));
    }
    if (SN.ExtInput && SN.ExtInput.channels) {
      SN.ExtInput.channels.forEach((ch, idx) => {
        const n = idx + 1;
        named.push([ch.el.querySelector('.ch-mute-btn'), 'mute-ext' + n]);
        named.push([ch.el.querySelector('.ch-ready-btn'), 'ready-ext' + n]);
        if (n > 1) named.push([ch.el.querySelector('.gate-toggle'), 'gate-ext' + n]);
      });
    }
    named.push([document.getElementById('lim-toggle'), 'limiter-on']);
    named.forEach(([btn, label]) => {
      if (!btn) return;
      btn.classList.add('midi-learnable');
      this._controls.push({
        id: 'button-' + label, element: btn, type: 'button',
        knobInstance: null, param: label, min: 0, max: 1
      });
    });

    // Attach right-click (contextmenu) listeners to all controls
    this._controls.forEach(ctrl => {
      ctrl.element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (this.enabled) {
          this._startLearning(ctrl);
        }
      });
    });
  },

  // ─── TOGGLE LEARN MODE ───
  _initToggle() {
    const toggleBtn = document.getElementById('midi-learn-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.enabled = !this.enabled;
        toggleBtn.classList.toggle('active', this.enabled);
        document.body.classList.toggle('midi-learn-active', this.enabled);

        if (!this.enabled) {
          this._cancelLearning();
        }

        this._setStatus(this.enabled ? 'RIGHT-CLICK CONTROL' : '');
        console.log('[MidiLearn]', this.enabled ? 'Enabled' : 'Disabled');
      });
    }

    // Clear all button
    const clearBtn = document.getElementById('midi-learn-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.clearAll();
      });
    }
  },

  // ─── SAVE / LOAD UI WIRING ───
  _initSaveLoad() {
    const saveBtn  = document.getElementById('midi-learn-save');
    const loadBtn  = document.getElementById('midi-learn-load');
    const fileIn   = document.getElementById('midi-learn-file-input');

    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.saveMapping());
    }

    if (loadBtn && fileIn) {
      loadBtn.addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            this.loadMapping(ev.target.result);
          } catch (err) {
            console.error('[MidiLearn] Load failed:', err);
            this._setStatus('LOAD FAILED');
          }
        };
        reader.onerror = () => {
          this._setStatus('READ ERROR');
        };
        reader.readAsText(file);
        // Reset so the same file can be re-loaded later
        fileIn.value = '';
      });
    }
  },

  // ─── START LEARNING ───
  _startLearning(ctrl) {
    if (this.learning) {
      this._cancelLearning();
    }

    this.learning = true;
    this._learningTarget = ctrl;

    // Highlight the target
    ctrl.element.classList.add('midi-learn-waiting');

    // Show overlay with instruction
    this._showOverlay('Move a knob/fader or press a button on any of your MIDI controllers (LEARN 1-4) to assign: ' + ctrl.param);
    this._setStatus('WAITING CC…');

    console.log('[MidiLearn] Learning:', ctrl.param);
  },

  _cancelLearning() {
    if (this._learningTarget) {
      this._learningTarget.element.classList.remove('midi-learn-waiting');
    }
    this.learning = false;
    this._learningTarget = null;
    this._hideOverlay();
    this._setStatus(this.enabled ? 'RIGHT-CLICK CONTROL' : '');
  },

  // ─── PROCESS INCOMING CC ───
  _key(slot, channel, cc) { return (slot || 1) + ':' + channel + ':' + cc; },

  onMIDICC(channel, cc, value, slot) {
    slot = slot || 1;
    const key = this._key(slot, channel, cc);

    // If learning, assign this CC to the waiting target
    if (this.learning && this._learningTarget) {
      // Remove any existing mapping for this CC
      if (this._mappings[key]) {
        this._mappings[key].element.classList.remove('midi-learn-mapped');
        const badge = this._mappings[key].element.querySelector('.midi-cc-badge');
        if (badge) badge.remove();
      }

      // Remove any existing mapping for this target (different CC)
      const existingKey = this._findKeyForParam(this._learningTarget.param);
      if (existingKey) {
        this._mappings[existingKey].element.classList.remove('midi-learn-mapped');
        const badge = this._mappings[existingKey].element.querySelector('.midi-cc-badge');
        if (badge) badge.remove();
        delete this._mappings[existingKey];
      }

      // Create mapping
      this._mappings[key] = {
        element: this._learningTarget.element,
        type: this._learningTarget.type,
        knobInstance: this._learningTarget.knobInstance,
        param: this._learningTarget.param,
        min: this._learningTarget.min,
        max: this._learningTarget.max,
        faderEl: this._learningTarget.faderEl || null,
        slot: slot, channel: channel, cc: cc
      };

      // Seed _lastValue so buttons don't fire a spurious click on assignment
      this._mappings[key]._lastValue = value;

      // Mark as mapped
      this._learningTarget.element.classList.remove('midi-learn-waiting');
      this._learningTarget.element.classList.add('midi-learn-mapped');

      // Add CC badge
      this._addCCBadge(this._learningTarget.element, channel, cc, slot);

      console.log('[MidiLearn] Mapped slot', slot, 'CC', cc, '(ch' + channel + ') →', this._learningTarget.param);

      this.learning = false;
      this._learningTarget = null;
      this._hideOverlay();
      this._setStatus('MAPPED ' + (slot > 1 ? slot + ':' : '') + 'CC' + cc + ' → ' + this._mappings[key].param);

      // Persist to localStorage immediately
      this._autoSave();

      // Apply the current value immediately (knobs/faders only; buttons are
      // seeded above and will wait for a real rising edge).
      if (this._mappings[key].type !== 'button') {
        this._applyCC(key, value);
      }
      return;
    }

    // Normal operation: apply CC if mapped
    if (this._mappings[key]) {
      this._applyCC(key, value);
    }
  },

  _applyCC(key, value) {
    const mapping = this._mappings[key];
    if (!mapping) return;

    if (mapping.type === 'knob' && mapping.knobInstance) {
      // Map 0-127 → min-max and let the knob's callback do the work
      const normalized = value / 127;
      const mapped = mapping.min + normalized * (mapping.max - mapping.min);
      mapping.knobInstance.setValue(mapped);
    } else if (mapping.type === 'fader' && mapping.faderEl) {
      const normalized = value / 127;
      const mapped = mapping.min + normalized * (mapping.max - mapping.min);
      mapping.faderEl.value = mapped;
      mapping.faderEl.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (mapping.type === 'button') {
      // Rising-edge: trigger click when CC crosses 64 upward.
      // Works with momentary pads (127→0) and toggle buttons (0↔127).
      const prev = mapping._lastValue || 0;
      if (value >= 64 && prev < 64) {
        mapping.element.click();
      }
      mapping._lastValue = value;
    }
  },

  _findKeyForParam(param) {
    for (const key in this._mappings) {
      if (this._mappings[key].param === param) return key;
    }
    return null;
  },

  // ─── CC BADGE ───
  _addCCBadge(element, channel, cc, slot) {
    slot = slot || 1;
    // Remove existing badge
    const existing = element.querySelector('.midi-cc-badge');
    if (existing) existing.remove();

    const badge = document.createElement('span');
    badge.className = 'midi-cc-badge';
    badge.textContent = (slot > 1 ? slot + '·' : '') + 'CC' + cc;
    if (slot > 1) badge.classList.add('midi-cc-badge-slot' + slot);
    badge.title = 'LEARN ' + slot + ' · MIDI Ch' + ((channel % 16) + 1) + ' ' + (channel >= 16 ? 'NOTE' : 'CC') + cc + ' — right-click to re-assign';

    // For knobs, position relative; for faders, position differently
    if (element.classList.contains('knob-wrap')) {
      element.style.position = 'relative';
      element.appendChild(badge);
    } else if (element.tagName === 'BUTTON') {
      element.style.position = 'relative';
      element.appendChild(badge);
    } else {
      // For faders, add badge to parent
      const parent = element.parentElement;
      if (parent) {
        parent.style.position = 'relative';
        parent.appendChild(badge);
      }
    }
  },

  // ─── CLEAR ALL ───
  clearAll() {
    Object.keys(this._mappings).forEach(key => {
      const m = this._mappings[key];
      m.element.classList.remove('midi-learn-mapped');
      const badge = m.element.querySelector('.midi-cc-badge');
      if (badge) badge.remove();
    });
    this._mappings = {};
    this._cancelLearning();
    this._autoSave(); // persist the empty state
    this._setStatus('CLEARED');
    setTimeout(() => {
      this._setStatus(this.enabled ? 'RIGHT-CLICK CONTROL' : '');
    }, 1500);
    console.log('[MidiLearn] All mappings cleared');
  },

  // ═══════════════════════════════════════════
  //  SAVE / LOAD — JSON file + localStorage
  // ═══════════════════════════════════════════

  // Build a portable snapshot of current mappings.
  // We store by `param` (the canonical control name), NOT by DOM reference.
  _serializeMappings() {
    const out = {};
    Object.keys(this._mappings).forEach(key => {
      const m = this._mappings[key];
      out[key] = {
        slot:    m.slot || 1,
        channel: m.channel,
        cc:      m.cc,
        param:   m.param,
        type:    m.type
      };
    });
    return out;
  },

  // Rebuild mappings from a serialized snapshot.
  // Returns { applied, missing } counts.
  _applySerializedMappings(serialized) {
    // Wipe existing UI state
    Object.keys(this._mappings).forEach(key => {
      const m = this._mappings[key];
      m.element.classList.remove('midi-learn-mapped');
      const badge = m.element.querySelector('.midi-cc-badge');
      if (badge) badge.remove();
    });
    this._mappings = {};

    // Build param -> control lookup from currently registered controls
    const byParam = {};
    this._controls.forEach(c => { byParam[c.param] = c; });

    let applied = 0;
    let missing = 0;

    Object.keys(serialized).forEach(key => {
      const entry = serialized[key];
      if (!entry || !entry.param) { missing++; return; }

      const ctrl = byParam[entry.param];
      if (!ctrl) {
        missing++;
        console.warn('[MidiLearn] Control not found on load:', entry.param);
        return;
      }

      // v1 entries have no slot → slot 1. v1 keys were "ch:cc".
      let slot = entry.slot | 0;
      let channel = entry.channel;
      let cc = entry.cc;
      if (channel === undefined || cc === undefined) {
        const parts = String(key).split(':').map(x => parseInt(x, 10));
        if (parts.length === 3) { slot = parts[0]; channel = parts[1]; cc = parts[2]; }
        else { channel = parts[0]; cc = parts[1]; }
      }
      slot = (slot >= 1 && slot <= 4) ? slot : 1;
      channel = channel | 0;
      cc = cc | 0;
      const mapKey  = this._key(slot, channel, cc);

      this._mappings[mapKey] = {
        element:      ctrl.element,
        type:         ctrl.type,
        knobInstance: ctrl.knobInstance,
        param:        ctrl.param,
        min:          ctrl.min,
        max:          ctrl.max,
        faderEl:      ctrl.faderEl || null,
        slot: slot, channel: channel, cc: cc,
        _lastValue:   0
      };

      ctrl.element.classList.add('midi-learn-mapped');
      this._addCCBadge(ctrl.element, channel, cc, slot);
      applied++;
    });

    return { applied, missing };
  },

  // Export current mapping as a downloadable JSON file
  saveMapping() {
    const count = this.getMappingCount();
    if (count === 0) {
      this._setStatus('NOTHING TO SAVE');
      setTimeout(() => {
        this._setStatus(this.enabled ? 'RIGHT-CLICK CONTROL' : '');
      }, 1500);
      return;
    }

    const data = {
      version:  2,
      app:      'Sessions Nocturnes',
      savedAt:  new Date().toISOString(),
      count:    count,
      slots:    (SN.MidiClock && SN.MidiClock.getSlotDeviceNames) ? SN.MidiClock.getSlotDeviceNames() : [],
      mappings: this._serializeMappings()
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);

    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'snm-midi-map-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this._setStatus('SAVED ' + count + ' MAPS');
    setTimeout(() => {
      this._setStatus(this.enabled ? 'RIGHT-CLICK CONTROL' : '');
    }, 2000);
    console.log('[MidiLearn] Saved', count, 'mappings');
  },

  // Import a mapping from a JSON string (from file) or object
  loadMapping(jsonOrString, silent) {
    let data;
    try {
      data = (typeof jsonOrString === 'string')
        ? JSON.parse(jsonOrString)
        : jsonOrString;
    } catch (e) {
      this._setStatus('BAD JSON');
      console.error('[MidiLearn] Invalid JSON:', e);
      return { applied: 0, missing: 0 };
    }

    if (!data || typeof data !== 'object' || !data.mappings) {
      this._setStatus('INVALID FILE');
      console.error('[MidiLearn] Invalid mapping file:', data);
      return { applied: 0, missing: 0 };
    }

    const result = this._applySerializedMappings(data.mappings);
    // V2: re-select the controllers saved with the file (by name)
    if (Array.isArray(data.slots) && SN.MidiClock && SN.MidiClock.setSlotDeviceNames) {
      SN.MidiClock.setSlotDeviceNames(data.slots);
    }
    this._autoSave(); // persist the newly loaded set

    if (!silent) {
      const total = result.applied + result.missing;
      const msg = result.missing > 0
        ? 'LOADED ' + result.applied + '/' + total + ' MAPS'
        : 'LOADED ' + result.applied + ' MAPS';
      this._setStatus(msg);
      setTimeout(() => {
        this._setStatus(this.enabled ? 'RIGHT-CLICK CONTROL' : '');
      }, 2500);
    }

    console.log('[MidiLearn] Loaded', result.applied, 'mappings (', result.missing, 'missing )');
    return result;
  },

  // Persist silently to localStorage
  _autoSave() {
    try {
      const data = {
        version:  2,
        savedAt:  new Date().toISOString(),
        mappings: this._serializeMappings()
      };
      localStorage.setItem(this._storageKey, JSON.stringify(data));
    } catch (e) {
      console.warn('[MidiLearn] Auto-save failed:', e);
    }
  },

  // Restore silently from localStorage on init
  _autoLoad() {
    try {
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !data.mappings) return;

      const result = this._applySerializedMappings(data.mappings);
      if (result.applied > 0) {
        this._setStatus('RESTORED ' + result.applied + ' MAPS');
        setTimeout(() => {
          this._setStatus(this.enabled ? 'RIGHT-CLICK CONTROL' : '');
        }, 2500);
        console.log('[MidiLearn] Auto-restored', result.applied, 'mappings');
      }
    } catch (e) {
      console.warn('[MidiLearn] Auto-load failed:', e);
    }
  },

  // ─── OVERLAY ───
  _createOverlay() {
    this._overlay = document.createElement('div');
    this._overlay.className = 'midi-learn-overlay';
    this._overlay.innerHTML = '<div class="midi-learn-overlay-msg"></div>';
    this._overlay.style.display = 'none';
    document.body.appendChild(this._overlay);

    // Click overlay to cancel
    this._overlay.addEventListener('click', () => {
      this._cancelLearning();
    });
  },

  _showOverlay(msg) {
    if (!this._overlay) return;
    this._overlay.querySelector('.midi-learn-overlay-msg').textContent = msg;
    this._overlay.style.display = 'flex';
  },

  _hideOverlay() {
    if (this._overlay) this._overlay.style.display = 'none';
  },

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text;
  },

  // ─── MAPPING COUNT ───
  getMappingCount() {
    return Object.keys(this._mappings).length;
  }
};
