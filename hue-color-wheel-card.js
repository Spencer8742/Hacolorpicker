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

const DEFAULTS = {
  wheel_size: 300,
  show_brightness: true,
  show_labels: true,
  pin_size: 36,
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
  const sat = radius > 0 ? (dist / radius) * 100 : 0;
  return [Math.round(hue * 10) / 10, Math.round(sat * 10) / 10];
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
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
    this._selected = null; // entity selected for brightness, null = all
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
        .pins { position: absolute; inset: 0; }
        .pin {
          position: absolute;
          left: 0; top: 0;
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
          transition: background-color 0.3s ease;
        }
        .pin.dragging .pin-circle { transition: none; }
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
        <div class="ct-note" hidden></div>
      </ha-card>
    `;

    this._wheelWrap = this.shadowRoot.querySelector(".wheel-wrap");
    this._canvas = this.shadowRoot.querySelector("canvas");
    this._pinsEl = this.shadowRoot.querySelector(".pins");
    this._brightnessLabel = this.shadowRoot.querySelector(".brightness-label");
    this._slider = this.shadowRoot.querySelector('input[type="range"]');
    this._ctNote = this.shadowRoot.querySelector(".ct-note");

    this._slider.addEventListener("input", () => this._onBrightnessInput());
    this._wheelWrap.addEventListener("pointerdown", (ev) => {
      // tap on empty wheel area deselects
      if (ev.target === this._canvas) this._select(null);
    });

    this._pins.clear();
    for (const light of this._lights) {
      const pin = document.createElement("div");
      pin.className = "pin";
      pin.dataset.entity = light.entity;
      const circle = document.createElement("div");
      circle.className = "pin-circle";
      pin.appendChild(circle);
      let label = null;
      if (this._config.show_labels) {
        label = document.createElement("div");
        label.className = "pin-label";
        pin.appendChild(label);
      }
      pin.addEventListener("pointerdown", (ev) => this._onPinDown(ev, light.entity));
      this._pinsEl.appendChild(pin);
      this._pins.set(light.entity, { el: pin, circle, label, cfg: light });
    }

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
    this._updateBrightnessUi();
  }

  _updatePin(entity, pin, stateObj) {
    const dragging = this._drag && this._drag.entity === entity;
    const exists = !!stateObj;
    const unavailable = !exists || stateObj.state === "unavailable" || stateObj.state === "unknown";
    const isOn = exists && stateObj.state === "on";

    if (pin.label) {
      pin.label.textContent =
        pin.cfg.label || (exists && stateObj.attributes.friendly_name) || entity;
    }

    pin.el.classList.toggle("unavailable", unavailable);
    pin.el.classList.toggle("off", !unavailable && !isOn);
    pin.el.classList.toggle("selected", this._selected === entity);

    if (isOn && Array.isArray(stateObj.attributes.hs_color)) {
      this._lastHs.set(entity, stateObj.attributes.hs_color.slice(0, 2));
    }

    if (dragging) return; // don't fight the user's finger

    const hs = this._lastHs.get(entity) || [0, 0];
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
      if (this._drag && this._drag.entity === entity) continue;
      const hs = this._lastHs.get(entity) || [0, 0];
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

    this._drag = {
      entity,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: false,
      lastHs: null,
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
    if (!drag.moved) {
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (Math.sqrt(dx * dx + dy * dy) < TAP_SLOP_PX) return;
      drag.moved = true;
      this._pins.get(entity).el.classList.add("dragging");
    }
    const hs = this._eventToHs(ev);
    drag.lastHs = hs;
    const pin = this._pins.get(entity);
    this._positionPin(pin, hs);
    pin.circle.style.background = rgbCss(hsv2rgb(hs[0], hs[1] / 100, 1));
    pin.el.classList.remove("off");
    this._throttledColorCall(entity, hs);
  }

  _onPinUp(ev, entity) {
    const drag = this._drag;
    if (!drag || drag.entity !== entity) return;
    this._drag = null;
    const pin = this._pins.get(entity);
    pin.el.classList.remove("dragging");

    if (!drag.moved) {
      this._onPinTap(entity);
      return;
    }
    if (drag.lastHs) {
      this._lastHs.set(entity, drag.lastHs);
      this._sendColor(entity, drag.lastHs); // final, authoritative call
    }
  }

  _onPinTap(entity) {
    const stateObj = this._hass.states[entity];
    if (stateObj && stateObj.state === "off") {
      this._hass.callService("light", "turn_on", { entity_id: entity });
      return;
    }
    this._select(this._selected === entity ? null : entity);
  }

  _select(entity) {
    this._selected = entity;
    for (const [id, pin] of this._pins) {
      pin.el.classList.toggle("selected", id === entity);
    }
    this._updateBrightnessUi();
  }

  _eventToHs(ev) {
    const rect = this._wheelWrap.getBoundingClientRect();
    const r = rect.width / 2;
    const dx = ev.clientX - (rect.left + r);
    const dy = ev.clientY - (rect.top + r);
    return xyToHs(dx, dy, r);
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
    this._sendColor(entity, hs, false);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      if (slot.pending) {
        const p = slot.pending;
        slot.pending = null;
        this._throttledColorCall(entity, p);
      }
    }, SERVICE_THROTTLE_MS);
  }

  _sendColor(entity, hs) {
    this._hass.callService("light", "turn_on", {
      entity_id: entity,
      hs_color: [hs[0], hs[1]],
    });
  }

  /* ------------------------------------------------------------ brightness */

  _updateBrightnessUi() {
    if (!this._config.show_brightness || this._sliderActive) return;
    if (this._selected) {
      const stateObj = this._hass.states[this._selected];
      const pin = this._pins.get(this._selected);
      this._brightnessLabel.textContent =
        pin?.cfg.label || stateObj?.attributes.friendly_name || this._selected;
      const b = stateObj?.attributes.brightness;
      this._slider.value = b != null ? Math.max(1, Math.round((b / 255) * 100)) : 100;
    } else {
      this._brightnessLabel.textContent = "All lights";
      const vals = [];
      for (const entity of this._pins.keys()) {
        const s = this._hass.states[entity];
        if (s?.state === "on" && s.attributes.brightness != null) {
          vals.push((s.attributes.brightness / 255) * 100);
        }
      }
      if (vals.length) {
        this._slider.value = Math.max(1, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
      }
    }
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
    if (this._selected) {
      this._hass.callService("light", "turn_on", {
        entity_id: this._selected,
        brightness_pct: pct,
      });
      return;
    }
    // global: only adjust lights that are currently on
    const targets = [...this._pins.keys()].filter(
      (e) => this._hass.states[e]?.state === "on"
    );
    if (targets.length) {
      this._hass.callService("light", "turn_on", {
        entity_id: targets,
        brightness_pct: pct,
      });
    }
  }
}

customElements.define("hue-color-wheel-card", HueColorWheelCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "hue-color-wheel-card",
  name: "Hue Color Wheel Card",
  description:
    "Philips Hue style color wheel with a draggable pin per light. Drag pins to change colors in real time.",
  preview: false,
});
