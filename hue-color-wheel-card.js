/**
 * hue-color-wheel-card
 *
 * A Home Assistant Lovelace card that replicates the Philips Hue app's
 * color wheel: one large HSV wheel with a draggable pin per light entity.
 * Dragging a pin calls light.turn_on with the matching hs_color.
 *
 * Install: copy this file to /config/www/ and add a dashboard resource:
 *   url: /local/hue-color-wheel-card.js
 *   type: module
 *
 * No build step, no dependencies.
 */

const CARD_VERSION = "0.4.0";

const DEFAULTS = {
  wheel_size: 300,
  show_brightness: true,
  show_labels: true,
  show_presets: true,
  pin_size: 36,
  merge_ring_size: 3,
  merge_distance: null, // px between pin centers to trigger a merge; null = pin_size
};

const SERVICE_THROTTLE_MS = 150; // ~6-7 calls/sec max while dragging
const TAP_SLOP_PX = 6; // movement below this counts as a tap, not a drag

const COLOR_MODES_WHEEL = ["hs", "xy", "rgb", "rgbw", "rgbww"];

/* ---------------------------------------------------------------- color math */

function hsv2rgb(h, s, v) {
  // h: 0-360, s: 0-1, v: 0-1 -> [r, g, b] 0-255
  const c = v * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function rgbCss([r, g, b]) {
  return `rgb(${r},${g},${b})`;
}

/**
 * hs -> wheel position. Hue 0 (red) points right, increasing
 * counter-clockwise (standard HSV wheel). Saturation 0 at center,
 * 100 at the rim.
 */
function hsToXy(hue, sat, radius) {
  const rad = (hue * Math.PI) / 180;
  const dist = (Math.min(Math.max(sat, 0), 100) / 100) * radius;
  return [dist * Math.cos(rad), -dist * Math.sin(rad)]; // y axis flipped on screen
}

function xyToHs(dx, dy, radius) {
  const dist = Math.min(Math.sqrt(dx * dx + dy * dy), radius);
  let hue = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  hue = Math.round(hue * 10) / 10;
  if (hue >= 360) hue -= 360;
  const sat = radius > 0 ? (dist / radius) * 100 : 0;
  return [hue, Math.round(sat * 10) / 10];
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ---------------------------------------------------------------- the card */

class HueColorWheelCard extends HTMLElement {
  static getStubConfig(hass) {
    const first = hass
      ? Object.keys(hass.states).find((e) => e.startsWith("light."))
      : undefined;
    return { lights: first ? [{ entity: first }] : [] };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._lights = null; // resolved [{entity, label}]
    this._pins = new Map(); // entity -> {el, circle, label}
    this._lastHs = new Map(); // entity -> [h, s] last seen while on
    this._lastBrightness = new Map(); // entity -> pct last seen while on
    this._saveTimer = null; // debounced persistence
    this._multi = new Set(); // entities selected for group drag / brightness
    this._selectedCluster = null; // cluster selected for brightness (first tap)
    this._clusters = []; // merged pin stacks: {members: [entity...], hs}
    this._clusterDirty = false;
    this._presets = {}; // preset name -> per-entity snapshot
    this._drag = null;
    this._radius = 0;
    this._pendingCalls = new Map(); // entity -> {timer, lastSent, pending}
    this._resizeObserver = null;
  }

  setConfig(config) {
    if (!config || (!config.lights && !config.auto_entities)) {
      throw new Error('hue-color-wheel-card: define "lights" or "auto_entities".');
    }
    if (config.lights && !Array.isArray(config.lights)) {
      throw new Error('hue-color-wheel-card: "lights" must be a list.');
    }
    this._config = { ...DEFAULTS, ...config };
    this._lights = null;
    this._built = false;
    if (this._hass) this._maybeBuild();
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeBuild();
    if (this._built) this._updateAll();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return Math.ceil((this._config?.wheel_size ?? 300) / 50) + 2;
  }

  connectedCallback() {
    this._maybeBuild();
  }

  disconnectedCallback() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    for (const p of this._pendingCalls.values()) clearTimeout(p.timer);
    this._pendingCalls.clear();
    clearTimeout(this._animTimer);
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveStore(); // flush before the card goes away
    }
    this._built = false;
  }

  /* ------------------------------------------------------------ light list */

  _resolveLights() {
    const cfg = this._config;
    if (cfg.lights) {
      return cfg.lights.map((item) =>
        typeof item === "string" ? { entity: item } : { entity: item.entity, label: item.label }
      );
    }
    // auto_entities: { area, domain, include_filter }
    const auto = cfg.auto_entities || {};
    const domain = auto.domain || "light";
    let ids = Object.keys(this._hass.states).filter((id) => id.startsWith(domain + "."));
    if (auto.include_filter) {
      const re = globToRegex(auto.include_filter);
      ids = ids.filter((id) => re.test(id));
    }
    if (auto.area) {
      const want = String(auto.area).toLowerCase();
      const reg = this._hass.entities || {};
      const devices = this._hass.devices || {};
      const areas = this._hass.areas || {};
      // accept either an area_id or an area name
      const areaIds = new Set(
        Object.values(areas)
          .filter((a) => a.area_id === auto.area || (a.name || "").toLowerCase() === want)
          .map((a) => a.area_id)
      );
      if (areaIds.size === 0) areaIds.add(auto.area);
      ids = ids.filter((id) => {
        const entry = reg[id];
        if (!entry) return false;
        const areaId = entry.area_id || (entry.device_id && devices[entry.device_id]?.area_id);
        return areaId && areaIds.has(areaId);
      });
    }
    return ids.map((entity) => ({ entity }));
  }

  _supportsColor(stateObj) {
    const modes = stateObj?.attributes?.supported_color_modes;
    if (!Array.isArray(modes)) return false;
    return modes.some((m) => COLOR_MODES_WHEEL.includes(m));
  }

  /* ------------------------------------------------------------ DOM build */

  _maybeBuild() {
    if (this._built || !this._config || !this._hass) return;
    this._lights = this._resolveLights();
    this._renderShell();
    this._built = true;
    this._updateAll();
  }

  _renderShell() {
    const cfg = this._config;
    const pinSize = cfg.pin_size;
    const hit = Math.max(pinSize, 44); // mobile touch target
    const ring = cfg.merge_ring_size; // white merge-target ring thickness

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
          padding: 16px;
          box-sizing: border-box;
        }
        .wheel-wrap {
          position: relative;
          width: 100%;
          max-width: ${cfg.wheel_size}px;
          aspect-ratio: 1 / 1;
          margin: 0 auto;
          touch-action: none;
        }
        canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 4px 24px rgba(0,0,0,0.4);
        }
        /* let empty-area taps fall through to the canvas; pins re-enable hits */
        .pins { position: absolute; inset: 0; pointer-events: none; }
        .pin {
          position: absolute;
          left: 0; top: 0;
          pointer-events: auto;
          width: ${hit}px;
          height: ${hit}px;
          margin-left: ${-hit / 2}px;
          margin-top: ${-hit / 2}px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: grab;
          touch-action: none;
          transition: transform 0.3s ease;
          will-change: transform;
        }
        .pin.dragging { transition: none; cursor: grabbing; z-index: 10; }
        .pin.selected .pin-circle {
          box-shadow: 0 0 0 3px var(--primary-color, #03a9f4), 0 2px 6px rgba(0,0,0,0.5);
        }
        .pin.off { opacity: 0.45; }
        .pin.off .pin-circle { filter: grayscale(0.7); }
        .pin.unavailable { opacity: 0.4; cursor: not-allowed; }
        .pin.cluster-hidden { opacity: 0; pointer-events: none; }
        .pin.merge-target .pin-circle {
          transform: scale(1.25);
          box-shadow: 0 0 0 ${ring}px rgba(255,255,255,0.7), 0 2px 6px rgba(0,0,0,0.5);
        }
        .pin-circle {
          width: ${pinSize}px;
          height: ${pinSize}px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.9);
          box-shadow: 0 2px 6px rgba(0,0,0,0.5);
          box-sizing: border-box;
          background: #888;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: ${Math.round(pinSize * 0.5)}px;
          color: #fff;
          text-shadow: 0 1px 2px rgba(0,0,0,0.8);
          user-select: none;
          -webkit-user-select: none;
          transition: background-color 0.3s ease, transform 0.15s ease;
        }
        .pin.dragging .pin-circle { transition: none; }
        .pin.animating { transition: transform 0.7s cubic-bezier(0.25, 0.8, 0.3, 1); }
        .pin.animating .pin-circle { transition: background-color 0.7s ease; }
        .pin-label {
          position: absolute;
          top: ${hit / 2 + pinSize / 2 + 2}px;
          left: 50%;
          transform: translateX(-50%);
          max-width: 90px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 11px;
          color: var(--primary-text-color, #e1e1e1);
          text-shadow: 0 1px 2px rgba(0,0,0,0.8);
          pointer-events: none;
          user-select: none;
          -webkit-user-select: none;
        }
        .pin-badge {
          display: none;
          position: absolute;
          top: ${(hit - pinSize) / 2 - 5}px;
          right: ${(hit - pinSize) / 2 - 5}px;
          min-width: 16px;
          height: 16px;
          padding: 0 3px;
          box-sizing: border-box;
          border-radius: 8px;
          background: #fff;
          color: #000;
          font-size: 10px;
          font-weight: 600;
          align-items: center;
          justify-content: center;
          box-shadow: 0 1px 3px rgba(0,0,0,0.5);
          pointer-events: none;
          z-index: 2;
        }
        .pin-badge.show { display: flex; }
        .brightness {
          display: ${cfg.show_brightness ? "flex" : "none"};
          align-items: center;
          gap: 12px;
          margin-top: 16px;
        }
        .brightness ha-icon { color: var(--secondary-text-color, #9e9e9e); }
        .brightness-label {
          font-size: 13px;
          color: var(--secondary-text-color, #9e9e9e);
          min-width: 70px;
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        input[type="range"] {
          flex: 1;
          -webkit-appearance: none;
          appearance: none;
          height: 32px;
          background: transparent;
          cursor: pointer;
        }
        input[type="range"]::-webkit-slider-runnable-track {
          height: 8px;
          border-radius: 4px;
          background: linear-gradient(to right, #444, #ffe9b0);
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 22px;
          height: 22px;
          margin-top: -7px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 4px rgba(0,0,0,0.5);
        }
        input[type="range"]::-moz-range-track {
          height: 8px;
          border-radius: 4px;
          background: linear-gradient(to right, #444, #ffe9b0);
        }
        input[type="range"]::-moz-range-thumb {
          width: 22px;
          height: 22px;
          border: none;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 4px rgba(0,0,0,0.5);
        }
        .presets {
          display: ${cfg.show_presets ? "flex" : "none"};
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          margin-top: 14px;
        }
        .chip, .save-btn, .save-ok, .save-cancel {
          font: inherit;
          font-size: 13px;
          color: var(--primary-text-color, #e1e1e1);
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 16px;
          padding: 6px 12px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 32px;
          box-sizing: border-box;
        }
        .chip:hover, .save-btn:hover { background: rgba(255,255,255,0.16); }
        .chip-del {
          opacity: 0.6;
          font-size: 14px;
          line-height: 1;
          padding: 2px;
        }
        .chip-del:hover { opacity: 1; }
        .save-form { display: inline-flex; align-items: center; gap: 6px; }
        /* author display rules above would defeat the hidden attribute */
        .save-form[hidden], .save-btn[hidden] { display: none; }
        .save-form input {
          font: inherit;
          font-size: 13px;
          color: var(--primary-text-color, #e1e1e1);
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.25);
          border-radius: 8px;
          padding: 6px 10px;
          width: 130px;
          outline: none;
        }
        .ct-note {
          margin-top: 12px;
          font-size: 12px;
          color: var(--secondary-text-color, #9e9e9e);
        }
      </style>
      <ha-card>
        <div class="wheel-wrap">
          <canvas></canvas>
          <div class="pins"></div>
        </div>
        <div class="brightness">
          <span class="brightness-label">All lights</span>
          <input type="range" min="1" max="100" value="100" aria-label="Brightness">
        </div>
        <div class="presets">
          <span class="chips"></span>
          <button class="save-btn">+ Save preset</button>
          <span class="save-form" hidden>
            <input type="text" maxlength="24" placeholder="Preset name" aria-label="Preset name">
            <button class="save-ok">Save</button>
            <button class="save-cancel">✕</button>
          </span>
        </div>
        <div class="ct-note" hidden></div>
      </ha-card>
    `;

    this._wheelWrap = this.shadowRoot.querySelector(".wheel-wrap");
    this._canvas = this.shadowRoot.querySelector("canvas");
    this._pinsEl = this.shadowRoot.querySelector(".pins");
    this._brightnessLabel = this.shadowRoot.querySelector(".brightness-label");
    this._slider = this.shadowRoot.querySelector('input[type="range"]');
    this._ctNote = this.shadowRoot.querySelector(".ct-note");

    this._chipsEl = this.shadowRoot.querySelector(".chips");
    this._saveBtn = this.shadowRoot.querySelector(".save-btn");
    this._saveForm = this.shadowRoot.querySelector(".save-form");
    this._saveInput = this.shadowRoot.querySelector(".save-form input");

    this._slider.addEventListener("input", () => this._onBrightnessInput());
    this._wheelWrap.addEventListener("pointerdown", (ev) => {
      // tap on empty wheel area clears the selection
      if (ev.target === this._canvas) {
        this._multi.clear();
        this._selectedCluster = null;
        this._refreshSelection();
      }
    });

    this._saveBtn.addEventListener("click", () => {
      this._saveBtn.hidden = true;
      this._saveForm.hidden = false;
      this._saveInput.value = "";
      this._saveInput.focus();
    });
    const closeSaveForm = () => {
      this._saveForm.hidden = true;
      this._saveBtn.hidden = false;
    };
    this.shadowRoot.querySelector(".save-cancel").addEventListener("click", closeSaveForm);
    const commitSave = () => {
      const name = this._saveInput.value.trim();
      if (name) this._capturePreset(name);
      closeSaveForm();
    };
    this.shadowRoot.querySelector(".save-ok").addEventListener("click", commitSave);
    this._saveInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") commitSave();
      if (ev.key === "Escape") closeSaveForm();
    });

    this._pins.clear();
    for (const light of this._lights) {
      const pin = document.createElement("div");
      pin.className = "pin";
      pin.dataset.entity = light.entity;
      const circle = document.createElement("div");
      circle.className = "pin-circle";
      pin.appendChild(circle);
      const badge = document.createElement("div");
      badge.className = "pin-badge";
      pin.appendChild(badge);
      let label = null;
      if (this._config.show_labels) {
        label = document.createElement("div");
        label.className = "pin-label";
        pin.appendChild(label);
      }
      pin.addEventListener("pointerdown", (ev) => this._onPinDown(ev, light.entity));
      this._pinsEl.appendChild(pin);
      this._pins.set(light.entity, { el: pin, circle, badge, label, cfg: light });
    }

    this._renderPresets();
    this._restoreStore(); // async; re-renders presets/clusters when loaded

    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this._wheelWrap);
    this._onResize();
  }

  /* ------------------------------------------------------------ wheel */

  _onResize() {
    const rect = this._wheelWrap.getBoundingClientRect();
    const size = Math.round(rect.width);
    if (!size || size === this._renderedSize) {
      this._radius = size / 2;
      this._positionAllPins();
      return;
    }
    this._renderedSize = size;
    this._radius = size / 2;
    this._drawWheel(size);
    this._positionAllPins();
  }

  _drawWheel(cssSize) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(cssSize * dpr);
    const canvas = this._canvas;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(px, px);
    const data = image.data;
    const c = px / 2;
    const r = px / 2;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = x - c;
        const dy = y - c;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const i = (y * px + x) * 4;
        if (dist > r + 1) continue; // transparent outside
        let hue = (Math.atan2(-dy, dx) * 180) / Math.PI;
        if (hue < 0) hue += 360;
        const sat = Math.min(dist / r, 1);
        const [rr, gg, bb] = hsv2rgb(hue, sat, 1);
        data[i] = rr;
        data[i + 1] = gg;
        data[i + 2] = bb;
        // soft anti-aliased rim
        data[i + 3] = dist > r - 1 ? Math.round(255 * Math.max(0, r + 1 - dist) / 2) : 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  /* ------------------------------------------------------------ state sync */

  _updateAll() {
    if (!this._built) return;
    const unsupported = [];
    for (const [entity, pin] of this._pins) {
      const stateObj = this._hass.states[entity];
      if (stateObj && !this._supportsColor(stateObj)) {
        pin.el.style.display = "none";
        unsupported.push(stateObj.attributes.friendly_name || entity);
        continue;
      }
      this._updatePin(entity, pin, stateObj);
    }
    this._ctNote.hidden = unsupported.length === 0;
    if (unsupported.length) {
      this._ctNote.textContent = `Not shown (no color support): ${unsupported.join(", ")}`;
    }
    this._refreshClusterStyles();
    this._updateBrightnessUi();
    if (this._clusterDirty) {
      // a member left its cluster mid-update; one more pass settles
      // labels and badges (memberships are stable on the second run)
      this._clusterDirty = false;
      this._updateAll();
    }
  }

  _updatePin(entity, pin, stateObj) {
    const dragging = this._drag && this._drag.members.has(entity);
    const exists = !!stateObj;
    const unavailable = !exists || stateObj.state === "unavailable" || stateObj.state === "unknown";
    const isOn = exists && stateObj.state === "on";

    pin.el.classList.toggle("unavailable", unavailable);
    pin.el.classList.toggle("off", !unavailable && !isOn);
    pin.el.classList.toggle("selected", this._multi.has(entity));

    if (isOn && Array.isArray(stateObj.attributes.hs_color)) {
      const hs = stateObj.attributes.hs_color.slice(0, 2);
      const prev = this._lastHs.get(entity);
      if (!prev || prev[0] !== hs[0] || prev[1] !== hs[1]) {
        this._lastHs.set(entity, hs);
        this._scheduleSave();
      }
    }
    if (isOn && stateObj.attributes.brightness != null) {
      const pct = Math.max(1, Math.round((stateObj.attributes.brightness / 255) * 100));
      if (this._lastBrightness.get(entity) !== pct) {
        this._lastBrightness.set(entity, pct);
        this._scheduleSave();
      }
    }

    // a member leaves its cluster when it turns off or when something
    // external moves its color visibly away from the stack
    let cluster = this._clusterFor(entity);
    if (cluster && !dragging) {
      const cur = this._lastHs.get(entity);
      let strayed = !unavailable && !isOn;
      if (!strayed && isOn && cur && this._radius > 0) {
        const a = hsToXy(cur[0], cur[1], this._radius);
        const b = hsToXy(cluster.hs[0], cluster.hs[1], this._radius);
        strayed = Math.hypot(a[0] - b[0], a[1] - b[1]) > this._mergeDistance();
      }
      if (strayed) {
        this._removeFromCluster(entity);
        this._clusterDirty = true;
        this._scheduleSave();
        cluster = null;
      }
    }

    if (pin.label) {
      const base = pin.cfg.label || (exists && stateObj.attributes.friendly_name) || entity;
      pin.label.textContent =
        cluster && cluster.members[0] === entity
          ? `${base} +${cluster.members.length - 1}`
          : base;
    }

    if (dragging) return; // don't fight the user's finger

    const hs = cluster ? cluster.hs : this._lastHs.get(entity) || [0, 0];
    this._positionPin(pin, hs);

    if (unavailable) {
      pin.circle.style.background = "#555";
      pin.circle.textContent = "!";
    } else {
      pin.circle.textContent = "";
      const rgb = isOn && Array.isArray(stateObj.attributes.rgb_color)
        ? stateObj.attributes.rgb_color
        : hsv2rgb(hs[0], hs[1] / 100, 1);
      pin.circle.style.background = rgbCss(rgb);
    }
  }

  _positionPin(pin, hs) {
    const r = this._radius;
    if (!r) return;
    const [x, y] = hsToXy(hs[0], hs[1], r);
    pin.el.style.transform = `translate(${r + x}px, ${r + y}px)`;
  }

  _positionAllPins() {
    for (const [entity, pin] of this._pins) {
      if (this._drag && this._drag.members.has(entity)) continue;
      const cluster = this._clusterFor(entity);
      const hs = cluster ? cluster.hs : this._lastHs.get(entity) || [0, 0];
      this._positionPin(pin, hs);
    }
  }

  /* ------------------------------------------------------------ dragging */

  _onPinDown(ev, entity) {
    const pin = this._pins.get(entity);
    if (!pin || pin.el.classList.contains("unavailable")) return;
    ev.preventDefault();
    ev.stopPropagation();
    pin.el.setPointerCapture(ev.pointerId);

    // dragging a selected pin moves the whole selection together; cluster
    // members always come along with their stack
    const seeds =
      this._multi.has(entity) && this._multi.size > 1 ? [...this._multi] : [entity];
    const group = [];
    for (const seed of seeds) {
      const cluster = this._clusterFor(seed);
      for (const id of cluster ? cluster.members : [seed]) {
        if (group.includes(id)) continue;
        if (this._pins.get(id)?.el.classList.contains("unavailable")) continue;
        group.push(id);
      }
    }

    // each member's wheel position at drag start; the pointer delta is
    // applied to all of them so the group keeps its relative arrangement
    const startXy = new Map();
    for (const id of group) {
      const cluster = this._clusterFor(id);
      const hs = cluster ? cluster.hs : this._lastHs.get(id) || [0, 0];
      startXy.set(id, hsToXy(hs[0], hs[1], this._radius));
    }

    this._drag = {
      entity,
      members: new Set(group),
      startXy,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: false,
      mergeTarget: null,
      lastHs: new Map(),
    };

    const onMove = (e) => this._onPinMove(e, entity);
    const onUp = (e) => {
      pin.el.removeEventListener("pointermove", onMove);
      pin.el.removeEventListener("pointerup", onUp);
      pin.el.removeEventListener("pointercancel", onUp);
      this._onPinUp(e, entity);
    };
    pin.el.addEventListener("pointermove", onMove);
    pin.el.addEventListener("pointerup", onUp);
    pin.el.addEventListener("pointercancel", onUp);
  }

  _onPinMove(ev, entity) {
    const drag = this._drag;
    if (!drag || drag.entity !== entity || ev.pointerId !== drag.pointerId) return;
    const dxp = ev.clientX - drag.startX;
    const dyp = ev.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.sqrt(dxp * dxp + dyp * dyp) < TAP_SLOP_PX) return;
      drag.moved = true;
      for (const id of drag.members) {
        this._pins.get(id).el.classList.add("dragging");
      }
    }
    const r = this._radius;
    let pressedX = 0;
    let pressedY = 0;
    for (const id of drag.members) {
      const [sx, sy] = drag.startXy.get(id);
      let x = sx + dxp;
      let y = sy + dyp;
      const dist = Math.sqrt(x * x + y * y);
      if (dist > r && dist > 0) {
        x *= r / dist;
        y *= r / dist;
      }
      if (id === entity) {
        pressedX = x;
        pressedY = y;
      }
      const hs = xyToHs(x, y, r);
      drag.lastHs.set(id, hs);
      const p = this._pins.get(id);
      p.el.style.transform = `translate(${r + x}px, ${r + y}px)`;
      p.circle.style.background = rgbCss(hsv2rgb(hs[0], hs[1] / 100, 1));
      p.el.classList.remove("off");
      this._throttledColorCall(id, hs);
    }

    // hovering near another pin offers a merge: highlight the target
    const target = this._findMergeTarget(pressedX, pressedY, drag.members);
    if (target !== drag.mergeTarget) {
      if (drag.mergeTarget) {
        this._pins.get(drag.mergeTarget)?.el.classList.remove("merge-target");
      }
      drag.mergeTarget = target;
      if (target) this._pins.get(target).el.classList.add("merge-target");
    }
  }

  _onPinUp(ev, entity) {
    const drag = this._drag;
    if (!drag || drag.entity !== entity) return;
    this._drag = null;
    for (const id of drag.members) {
      this._pins.get(id).el.classList.remove("dragging");
    }
    if (drag.mergeTarget) {
      this._pins.get(drag.mergeTarget)?.el.classList.remove("merge-target");
    }

    if (!drag.moved) {
      this._onPinTap(entity);
      return;
    }

    if (drag.mergeTarget) {
      // dropped onto another pin: snap the dragged lights into its stack
      this._mergeInto(drag.mergeTarget, drag.members);
      return;
    }

    for (const [id, hs] of drag.lastHs) {
      this._lastHs.set(id, hs);
      this._sendColor(id, hs); // final, authoritative call
    }
    // clusters dragged as a whole keep their stacked position
    for (const cluster of this._clusters) {
      if (cluster.members.every((m) => drag.members.has(m))) {
        const hs = drag.lastHs.get(cluster.members[0]);
        if (hs) cluster.hs = hs.slice();
      }
    }
    this._scheduleSave();
  }

  _onPinTap(entity) {
    const cluster = this._clusterFor(entity);
    if (cluster) {
      if (this._selectedCluster === cluster) {
        // second tap on the same stack: split it
        this._selectedCluster = null;
        this._multi.clear();
        this._refreshSelection();
        this._splitCluster(cluster);
      } else {
        // first tap: select all cluster members for brightness control
        this._selectedCluster = cluster;
        this._multi = new Set(cluster.members);
        this._refreshSelection();
      }
      return;
    }
    // tapping a non-cluster pin clears any cluster selection
    this._selectedCluster = null;
    const stateObj = this._hass.states[entity];
    if (stateObj && stateObj.state === "off") {
      this._hass.callService("light", "turn_on", { entity_id: entity });
      return;
    }
    // tap toggles membership in the multi-selection
    if (this._multi.has(entity)) this._multi.delete(entity);
    else this._multi.add(entity);
    this._refreshSelection();
  }

  _refreshSelection() {
    for (const [id, pin] of this._pins) {
      pin.el.classList.toggle("selected", this._multi.has(id));
    }
    this._updateBrightnessUi();
  }

  /* ------------------------------------------------------------ service calls */

  _throttledColorCall(entity, hs) {
    let slot = this._pendingCalls.get(entity);
    if (!slot) {
      slot = { timer: null, pending: null };
      this._pendingCalls.set(entity, slot);
    }
    if (slot.timer) {
      slot.pending = hs; // trailing value, sent when the timer fires
      return;
    }
    this._sendColor(entity, hs);
    // widen the per-light interval for group drags so the total call
    // rate across the group stays in the same ballpark
    const groupSize = this._drag ? this._drag.members.size : 1;
    const interval = Math.min(SERVICE_THROTTLE_MS * Math.max(groupSize, 1), 500);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      if (slot.pending) {
        const p = slot.pending;
        slot.pending = null;
        this._throttledColorCall(entity, p);
      }
    }, interval);
  }

  _sendColor(entity, hs) {
    this._hass.callService("light", "turn_on", {
      entity_id: entity,
      hs_color: [hs[0], hs[1]],
    });
  }

  /* ------------------------------------------------------------ clusters */

  _clusterFor(entity) {
    return this._clusters.find((c) => c.members.includes(entity)) || null;
  }

  _removeFromCluster(entity) {
    const cluster = this._clusterFor(entity);
    if (!cluster) return;
    cluster.members = cluster.members.filter((id) => id !== entity);
    if (cluster.members.length < 2) {
      this._clusters = this._clusters.filter((c) => c !== cluster);
    }
  }

  /** Snap distance (px between pin centers) for merging / staying merged. */
  _mergeDistance() {
    const d = this._config.merge_distance;
    return d != null ? d : this._config.pin_size;
  }

  _refreshClusterStyles() {
    for (const [entity, pin] of this._pins) {
      const cluster = this._clusterFor(entity);
      const isRep = !!cluster && cluster.members[0] === entity;
      pin.el.classList.toggle("cluster-hidden", !!cluster && !isRep);
      pin.badge.classList.toggle("show", isRep);
      if (isRep) pin.badge.textContent = String(cluster.members.length);
    }
  }

  /** Find an "on", visible pin near (x, y) wheel coords to merge into. */
  _findMergeTarget(x, y, excludeSet) {
    const r = this._radius;
    let best = null;
    let bestDist = this._mergeDistance(); // snap distance between centers
    for (const [id, pin] of this._pins) {
      if (excludeSet.has(id)) continue;
      if (pin.el.style.display === "none") continue;
      const s = this._hass.states[id];
      if (!s || s.state !== "on") continue;
      const cluster = this._clusterFor(id);
      if (cluster && cluster.members[0] !== id) continue; // only the visible top pin
      const hs = cluster ? cluster.hs : this._lastHs.get(id) || [0, 0];
      const [tx, ty] = hsToXy(hs[0], hs[1], r);
      const dist = Math.hypot(tx - x, ty - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = id;
      }
    }
    return best;
  }

  _mergeInto(targetEntity, draggedMembers) {
    const targetCluster = this._clusterFor(targetEntity);
    const hs = (targetCluster ? targetCluster.hs : this._lastHs.get(targetEntity) || [0, 0]).slice();
    const members = targetCluster ? [...targetCluster.members] : [targetEntity];
    const moved = [...draggedMembers];
    this._clusters = this._clusters.filter(
      (c) => c !== targetCluster && !moved.some((id) => c.members.includes(id))
    );
    for (const id of moved) {
      if (!members.includes(id)) members.push(id);
    }
    this._clusters.push({ members, hs });
    this._scheduleSave();
    for (const id of moved) {
      this._lastHs.set(id, hs.slice());
      const pin = this._pins.get(id);
      pin.el.classList.add("animating");
      this._positionPin(pin, hs);
      pin.circle.style.background = rgbCss(hsv2rgb(hs[0], hs[1] / 100, 1));
      this._sendColor(id, hs);
    }
    this._refreshClusterStyles();
    this._updateAll();
    clearTimeout(this._animTimer);
    this._animTimer = setTimeout(() => {
      for (const pin of this._pins.values()) pin.el.classList.remove("animating");
    }, 800);
  }

  _splitCluster(cluster) {
    this._clusters = this._clusters.filter((c) => c !== cluster);
    this._scheduleSave();
    const r = this._radius;
    const [cx, cy] = hsToXy(cluster.hs[0], cluster.hs[1], r);
    const spread = Math.max(this._config.pin_size, 30);
    const n = cluster.members.length;
    cluster.members.forEach((id, i) => {
      const angle = (i / n) * 2 * Math.PI;
      let x = cx + spread * Math.cos(angle);
      let y = cy + spread * Math.sin(angle);
      const dist = Math.hypot(x, y);
      if (dist > r && dist > 0) {
        x *= r / dist;
        y *= r / dist;
      }
      const hs = xyToHs(x, y, r);
      this._lastHs.set(id, hs);
      const pin = this._pins.get(id);
      pin.el.classList.add("animating");
      pin.el.style.transform = `translate(${r + x}px, ${r + y}px)`;
      pin.circle.style.background = rgbCss(hsv2rgb(hs[0], hs[1] / 100, 1));
      this._sendColor(id, hs);
    });
    this._refreshClusterStyles();
    this._updateAll();
    clearTimeout(this._animTimer);
    this._animTimer = setTimeout(() => {
      for (const pin of this._pins.values()) pin.el.classList.remove("animating");
    }, 800);
  }

  /* ------------------------------------------------------------ persistence
   *
   * Clusters, last-known colors/brightness, and presets are saved to Home
   * Assistant's per-user frontend storage (frontend/set_user_data), so they
   * survive reloads and follow the user across pages, browsers, and devices.
   * localStorage doubles as a synchronous fallback for older HA versions.
   */

  _entityKey() {
    return this._lights.map((l) => l.entity).sort().join(",");
  }

  _storeKey() {
    return `hue_color_wheel_card_${hashString(this._entityKey())}`;
  }

  _localKey() {
    return `hue-color-wheel-card:store:${this._entityKey()}`;
  }

  async _loadStore() {
    try {
      const resp = await this._hass.callWS({
        type: "frontend/get_user_data",
        key: this._storeKey(),
      });
      if (resp && resp.value) return resp.value;
    } catch (e) {
      // older HA or WS hiccup: fall back to this browser's storage
    }
    try {
      const local = JSON.parse(localStorage.getItem(this._localKey()));
      if (local) return local;
    } catch (e) {
      /* ignore */
    }
    // migrate presets saved by pre-0.4 card versions
    try {
      const legacy = JSON.parse(
        localStorage.getItem(`hue-color-wheel-card:presets:${this._entityKey()}`)
      );
      if (legacy) return { presets: legacy };
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  async _restoreStore() {
    const data = await this._loadStore();
    if (!data || !this._built) return;
    if (data.presets && typeof data.presets === "object") {
      this._presets = data.presets;
      this._renderPresets();
    }
    if (data.lastHs) {
      for (const [entity, hs] of Object.entries(data.lastHs)) {
        // live state wins; restored values fill in lights that are off now
        if (this._pins.has(entity) && !this._lastHs.has(entity) && Array.isArray(hs)) {
          this._lastHs.set(entity, hs.slice(0, 2));
        }
      }
    }
    if (data.lastBrightness) {
      for (const [entity, pct] of Object.entries(data.lastBrightness)) {
        if (this._pins.has(entity) && !this._lastBrightness.has(entity)) {
          this._lastBrightness.set(entity, pct);
        }
      }
    }
    if (Array.isArray(data.clusters)) {
      // restored stacks are re-validated by the stray check: members whose
      // live color moved away since last session pop back out on their own
      this._clusters = data.clusters
        .map((c) => ({
          members: (c.members || []).filter((id) => this._pins.has(id)),
          hs: Array.isArray(c.hs) ? c.hs.slice(0, 2) : null,
        }))
        .filter((c) => c.members.length >= 2 && c.hs);
    }
    this._updateAll();
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveStore(), 2000);
  }

  _saveStore() {
    this._saveTimer = null;
    if (!this._lights) return;
    const value = {
      v: 1,
      clusters: this._clusters.map((c) => ({ members: [...c.members], hs: c.hs })),
      lastHs: Object.fromEntries(this._lastHs),
      lastBrightness: Object.fromEntries(this._lastBrightness),
      presets: this._presets,
    };
    try {
      localStorage.setItem(this._localKey(), JSON.stringify(value));
    } catch (e) {
      /* storage full or unavailable */
    }
    if (this._hass) {
      this._hass
        .callWS({ type: "frontend/set_user_data", key: this._storeKey(), value })
        .catch(() => {});
    }
  }

  /* ------------------------------------------------------------ presets */

  _capturePreset(name) {
    const snapshot = {};
    for (const entity of this._pins.keys()) {
      const s = this._hass.states[entity];
      if (!s || s.state === "unavailable" || s.state === "unknown") continue;
      const hs = this._lastHs.get(entity) || s.attributes.hs_color || [0, 0];
      snapshot[entity] = {
        on: s.state === "on",
        hs: [hs[0], hs[1]],
        brightness_pct:
          s.attributes.brightness != null
            ? Math.round((s.attributes.brightness / 255) * 100)
            : null,
      };
    }
    this._presets[name] = snapshot;
    this._scheduleSave();
    this._renderPresets();
  }

  _deletePreset(name) {
    delete this._presets[name];
    this._scheduleSave();
    this._renderPresets();
  }

  _applyPreset(name) {
    const snapshot = this._presets[name];
    if (!snapshot) return;
    // presets recall exact per-light positions, so dissolve any stacks
    this._clusters = [];
    this._selectedCluster = null;
    this._multi.clear();
    this._refreshClusterStyles();
    this._scheduleSave();
    for (const [entity, saved] of Object.entries(snapshot)) {
      const pin = this._pins.get(entity);
      if (!pin || pin.el.classList.contains("unavailable")) continue;
      if (saved.on) {
        // move the pin optimistically with a slow ease; the subsequent
        // hass updates land on the same position, so no snap-back
        pin.el.classList.add("animating");
        pin.el.classList.remove("off");
        this._lastHs.set(entity, saved.hs);
        this._positionPin(pin, saved.hs);
        pin.circle.style.background = rgbCss(hsv2rgb(saved.hs[0], saved.hs[1] / 100, 1));
        const data = { entity_id: entity, hs_color: saved.hs };
        if (saved.brightness_pct != null) data.brightness_pct = saved.brightness_pct;
        this._hass.callService("light", "turn_on", data);
      } else {
        this._hass.callService("light", "turn_off", { entity_id: entity });
      }
    }
    clearTimeout(this._animTimer);
    this._animTimer = setTimeout(() => {
      for (const pin of this._pins.values()) pin.el.classList.remove("animating");
    }, 800);
  }

  _renderPresets() {
    if (!this._chipsEl) return;
    this._chipsEl.textContent = "";
    for (const name of Object.keys(this._presets)) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.title = `Activate "${name}"`;
      const text = document.createElement("span");
      text.textContent = name;
      const del = document.createElement("span");
      del.className = "chip-del";
      del.textContent = "✕";
      del.title = `Delete "${name}"`;
      chip.append(text, del);
      chip.addEventListener("click", (ev) => {
        if (ev.target === del) this._deletePreset(name);
        else this._applyPreset(name);
      });
      this._chipsEl.appendChild(chip);
    }
  }

  /* ------------------------------------------------------------ brightness */

  _updateBrightnessUi() {
    if (!this._config.show_brightness || this._sliderActive) return;
    const targets = this._brightnessTargets();
    if (targets.size === 0) {
      this._brightnessLabel.textContent = "All lights";
    } else if (targets.size === 1) {
      const entity = [...targets][0];
      const stateObj = this._hass.states[entity];
      const pin = this._pins.get(entity);
      this._brightnessLabel.textContent =
        pin?.cfg.label || stateObj?.attributes.friendly_name || entity;
      const b = stateObj?.attributes.brightness;
      this._slider.value =
        b != null
          ? Math.max(1, Math.round((b / 255) * 100))
          : this._lastBrightness.get(entity) ?? 100;
      return;
    } else if (this._selectedCluster) {
      this._brightnessLabel.textContent = `Group (${targets.size} lights)`;
    } else {
      this._brightnessLabel.textContent = `${targets.size} lights`;
    }
    const vals = [];
    for (const entity of targets) {
      const s = this._hass.states[entity];
      if (s?.state === "on" && s.attributes.brightness != null) {
        vals.push((s.attributes.brightness / 255) * 100);
      }
    }
    if (!vals.length) {
      // fall back to all on-lights when nothing useful in selection
      for (const entity of this._pins.keys()) {
        const s = this._hass.states[entity];
        if (s?.state === "on" && s.attributes.brightness != null) {
          vals.push((s.attributes.brightness / 255) * 100);
        }
      }
    }
    if (vals.length) {
      this._slider.value = Math.max(1, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
    }
  }

  /** Expanded set of entity IDs the brightness slider should target. */
  _brightnessTargets() {
    if (!this._multi.size) return new Set(); // means "all on lights"
    // expand through clusters so stacked members are included even if only
    // the representative pin is in _multi
    const result = new Set();
    for (const id of this._multi) {
      const cluster = this._clusterFor(id);
      if (cluster) cluster.members.forEach((m) => result.add(m));
      else result.add(id);
    }
    return result;
  }

  _onBrightnessInput() {
    this._sliderActive = true;
    clearTimeout(this._sliderIdleTimer);
    this._sliderIdleTimer = setTimeout(() => (this._sliderActive = false), 1000);

    const pct = Number(this._slider.value);
    const now = Date.now();
    if (this._lastBrightnessCall && now - this._lastBrightnessCall < SERVICE_THROTTLE_MS) {
      clearTimeout(this._brightnessTrailing);
      this._brightnessTrailing = setTimeout(() => this._sendBrightness(pct), SERVICE_THROTTLE_MS);
      return;
    }
    this._lastBrightnessCall = now;
    this._sendBrightness(pct);
  }

  _sendBrightness(pct) {
    this._lastBrightnessCall = Date.now();
    const targets = this._brightnessTargets();
    if (targets.size) {
      this._hass.callService("light", "turn_on", {
        entity_id: [...targets],
        brightness_pct: pct,
      });
      return;
    }
    // global: only adjust lights that are currently on
    const onLights = [...this._pins.keys()].filter(
      (e) => this._hass.states[e]?.state === "on"
    );
    if (onLights.length) {
      this._hass.callService("light", "turn_on", {
        entity_id: onLights,
        brightness_pct: pct,
      });
    }
  }
}

customElements.define("hue-color-wheel-card", HueColorWheelCard);

console.info(
  `%c HUE-COLOR-WHEEL-CARD %c v${CARD_VERSION} `,
  "background:#3f51b5;color:#fff;padding:2px 6px;border-radius:4px 0 0 4px",
  "background:#222;color:#9fa8da;padding:2px 6px;border-radius:0 4px 4px 0"
);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "hue-color-wheel-card",
  name: "Hue Color Wheel Card",
  description:
    "Philips Hue style color wheel with a draggable pin per light. Drag pins to change colors in real time.",
  preview: false,
});
