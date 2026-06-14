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

const CARD_VERSION = "0.10.1";

const DEFAULTS = {
  wheel_size: 300,
  show_brightness: true,
  show_labels: true,
  show_presets: true,
  show_white_toggle: true, // show the color/white (temperature) mode toggle
  show_swatches: true, // quick-color swatch row + randomize button
  show_effects: true, // effects toggle (only appears if lights support effects)
  enable_haptics: true, // light vibration on merge/long-press where supported
  pin_size: 36,
  merge_ring_size: 3,
  merge_distance: null, // px between pin centers to trigger a merge; null = pin_size
};

const LONG_PRESS_MS = 500;

// default quick-color swatches (hue, saturation)
const DEFAULT_SWATCHES = [
  [0, 100], [30, 100], [50, 100], [120, 80], [180, 90],
  [210, 90], [270, 90], [300, 85], [0, 0],
];

const SERVICE_THROTTLE_MS = 150; // ~6-7 calls/sec max while dragging
// generous tap slop accounts for finger jitter on mobile — a strict 6px
// threshold causes touch taps to occasionally register as drags
const TAP_SLOP_PX = 10;
// After a stack's color is authoritatively set (merge or drag release), the
// bulbs lag and Home Assistant streams back stale mid-drag state echoes.
// We ignore stray detection during this window so those echoes can't
// dissolve the stack. Tuned for slow bulbs like Hue.
const CLUSTER_SETTLE_MS = 3000;

const COLOR_MODES_WHEEL = ["hs", "xy", "rgb", "rgbw", "rgbww"];

// white-mode color-temperature range (Kelvin) used for the gradient and pin
// positioning; per-light sends are clamped to each light's own range.
const TEMP_MIN_K = 2000; // warmest (amber) — top of the wheel
const TEMP_MAX_K = 6500; // coolest (blue-white) — bottom of the wheel
const DEFAULT_TEMP_K = 3500; // neutral default for values not yet set in white mode

/* ---------------------------------------------------------------- color math */

/** Approximate a color temperature in Kelvin as [r, g, b] 0-255. */
function kelvinToRgb(kelvin) {
  const t = Math.min(Math.max(kelvin, 1000), 40000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (v) => Math.round(Math.min(Math.max(v, 0), 255));
  return [clamp(r), clamp(g), clamp(b)];
}

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

/** White mode: Kelvin -> vertical offset (warm at top, cool at bottom). */
function tempToY(kelvin, radius) {
  const frac = (Math.min(Math.max(kelvin, TEMP_MIN_K), TEMP_MAX_K) - TEMP_MIN_K) /
    (TEMP_MAX_K - TEMP_MIN_K);
  return -radius + frac * 2 * radius;
}

/** White mode: vertical offset -> Kelvin. */
function yToTemp(y, radius) {
  const frac = radius > 0 ? Math.min(Math.max((y + radius) / (2 * radius), 0), 1) : 0;
  return Math.round(TEMP_MIN_K + frac * (TEMP_MAX_K - TEMP_MIN_K));
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
    this._lastTemp = new Map(); // entity -> kelvin last seen (white mode)
    this._whiteX = new Map(); // entity -> x offset for the white-mode pin
    this._mode = "color"; // "color" (hue wheel) or "white" (temp gradient)
    this._lastBrightness = new Map(); // entity -> pct last seen while on
    this._saveTimer = null; // debounced remote sync
    this._pendingSave = null; // value awaiting remote sync
    this._restoring = false; // true while loading persisted state
    this._storeUpdatedAt = 0; // updatedAt of the store data we've applied
    this._warnedWrite = false; // logged a remote-write failure once
    this._conn = null; // hass.connection we've hooked 'ready' on
    // Storage backend: "shared" = cross-user hue_color_wheel integration,
    // "user" = per-user frontend/set_user_data fallback, null = not detected.
    this._storageMode = null;
    this._subscribed = false; // live push subscription active
    this._unsub = null; // unsubscribe fn for the live push
    // When the page/app comes to the foreground, pull the latest shared
    // state from the server (covers "I changed it on another device"); when
    // it goes to the background, flush any pending write first.
    this._visibilityHandler = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        if (this._pendingSave) this._syncRemote();
      } else {
        this._syncFromServer();
      }
    };
    this._flushHandler = () => {
      if (this._pendingSave) this._syncRemote();
    };
    this._multi = new Set(); // entities selected for group drag / brightness
    this._selectedCluster = null; // cluster selected for brightness (first tap)
    this._clusters = []; // merged pin stacks: {members, hs, temp, no}
    this._groupSeq = 0; // counter for stable "Group N" labels
    this._expandedCluster = null; // cluster currently opened into a ring
    this._expand = null; // {cluster, cx, cy, trayR, slots} geometry while open
    this._clusterDirty = false;
    this._presets = {}; // preset name -> per-entity snapshot
    this._drag = null;
    this._radius = 0;
    this._pendingCalls = new Map(); // entity -> {timer, lastSent, pending}
    this._resizeObserver = null;
    this._longPressTimer = null; // pending long-press -> popover
    this._popoverFor = null; // entity/cluster the popover targets
    this._effectsOpen = false;
    this._seededGroups = false; // declarative groups applied once
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
    // Re-pull shared state whenever the WebSocket reconnects, so a device
    // that was asleep/offline catches up on changes made elsewhere.
    const conn = hass && hass.connection;
    if (conn && conn !== this._conn && typeof conn.addEventListener === "function") {
      this._conn = conn;
      conn.addEventListener("ready", () => this._syncFromServer());
    }
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
    window.addEventListener("pagehide", this._flushHandler);
    document.addEventListener("visibilitychange", this._visibilityHandler);
    this._maybeBuild();
  }

  disconnectedCallback() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    // detach any in-flight drag's window listeners so we don't leak them
    if (this._drag && this._drag.cleanup) this._drag.cleanup();
    this._drag = null;
    clearTimeout(this._longPressTimer);
    for (const p of this._pendingCalls.values()) clearTimeout(p.timer);
    this._pendingCalls.clear();
    clearTimeout(this._animTimer);
    window.removeEventListener("pagehide", this._flushHandler);
    document.removeEventListener("visibilitychange", this._visibilityHandler);
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
      this._subscribed = false;
    }
    if (this._pendingSave) this._syncRemote(); // flush remote before teardown
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

  _supportsTemp(stateObj) {
    const modes = stateObj?.attributes?.supported_color_modes;
    return Array.isArray(modes) && modes.includes("color_temp");
  }

  _supportsMode(stateObj) {
    return this._mode === "white"
      ? this._supportsTemp(stateObj)
      : this._supportsColor(stateObj);
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
          position: relative;
        }
        .card-header {
          display: ${cfg.title === false ? "none" : "flex"};
          align-items: center;
          gap: 8px;
          margin: 0 0 12px 2px;
          font-size: 17px;
          font-weight: 500;
          color: var(--primary-text-color, #e1e1e1);
        }
        .card-header ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color, #9e9e9e); }
        .wheel-wrap {
          position: relative;
          width: 100%;
          max-width: ${cfg.wheel_size}px;
          aspect-ratio: 1 / 1;
          margin: 0 auto;
          /* prevent the page from scrolling/zooming when a pin is dragged
             on touch devices — applied to every layer that can receive a
             touch so iOS Safari doesn't fall back to default gestures */
          touch-action: none;
          -webkit-user-select: none;
          user-select: none;
          -webkit-touch-callout: none;
        }
        canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 4px 24px rgba(0,0,0,0.45);
          touch-action: none;
          /* brightness of the wheel tracks the lights (set inline) */
          filter: brightness(1);
          transition: filter 0.4s ease;
        }
        /* live numeric readout that fades in while dragging */
        .value-readout {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          padding: 6px 12px;
          border-radius: 14px;
          background: rgba(0,0,0,0.55);
          color: #fff;
          font-size: 15px;
          font-weight: 600;
          letter-spacing: 0.3px;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.18s ease;
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
        }
        .value-readout.show { opacity: 1; }
        /* let empty-area taps fall through to the canvas; pins re-enable hits */
        .pins { position: absolute; inset: 0; pointer-events: none; touch-action: none; }
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
          transition: transform 0.45s cubic-bezier(0.34, 1.4, 0.5, 1);
          will-change: transform;
        }
        .pin.dragging { transition: none; cursor: grabbing; z-index: 30; }
        .pin.selected { z-index: 20; }
        .pin.selected .pin-circle {
          box-shadow: 0 0 0 3px var(--primary-color, #03a9f4), 0 2px 7px rgba(0,0,0,0.55);
        }
        /* inside an open ring every member is "selected"; a thin white ring
           reads far cleaner than a dozen heavy blue halos */
        .pins.ring-open .pin.selected .pin-circle {
          box-shadow: 0 0 0 2px rgba(255,255,255,0.92), 0 2px 8px rgba(0,0,0,0.6);
        }
        .pin.pressing { z-index: 25; }
        .pin.off { opacity: 0.5; }
        .pin.off .pin-circle { filter: grayscale(0.6) brightness(0.7); }
        .pin.unavailable { opacity: 0.4; cursor: not-allowed; }
        .pin.cluster-hidden { opacity: 0; pointer-events: none; }
        /* a member dragged clear of the ring will be removed on release */
        .pin.removing .pin-circle {
          box-shadow: 0 0 0 3px rgba(255,90,90,0.95), 0 2px 6px rgba(0,0,0,0.5);
        }
        /* the inner "well" shown when a stack is opened; pins sit on its rim */
        .expand-tray {
          position: absolute;
          left: 0; top: 0;
          border-radius: 50%;
          /* a frosted lens that dims the wheel under it without going black,
             so the white-ringed pins read clearly on its rim */
          background: radial-gradient(circle at 50% 40%, rgba(70,70,76,0.42), rgba(20,20,24,0.62));
          box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.22), inset 0 6px 22px rgba(0,0,0,0.3), 0 10px 34px rgba(0,0,0,0.55);
          backdrop-filter: blur(10px) saturate(0.85);
          -webkit-backdrop-filter: blur(10px) saturate(0.85);
          transform: translate(-50%, -50%);
          pointer-events: none;
          transition: opacity 0.22s ease, width 0.25s ease, height 0.25s ease;
          /* sits above the canvas but below the pins (which follow it in the
             DOM) so the light markers and labels are never covered */
        }
        .expand-tray[hidden] { display: none; }
        .pin.merge-target .pin-circle {
          transform: scale(1.28);
          box-shadow: 0 0 0 ${ring}px rgba(255,255,255,0.7), 0 2px 6px rgba(0,0,0,0.5);
        }
        /* teardrop marker: round body with a small downward tail at its tip */
        .pin-circle {
          position: relative;
          width: ${pinSize}px;
          height: ${pinSize}px;
          border-radius: 50% 50% 50% 50%;
          border: 2px solid rgba(255,255,255,0.92);
          box-shadow: 0 2px 7px rgba(0,0,0,0.55);
          box-sizing: border-box;
          background: #888;
          display: flex;
          align-items: center;
          justify-content: center;
          color: rgba(255,255,255,0.92);
          --mdc-icon-size: ${Math.round(pinSize * 0.55)}px;
          font-size: ${Math.round(pinSize * 0.46)}px;
          font-weight: 600;
          text-shadow: 0 1px 2px rgba(0,0,0,0.85);
          user-select: none;
          -webkit-user-select: none;
          transition: background-color 0.3s ease, transform 0.15s ease;
        }
        .pin-circle::after {
          content: "";
          position: absolute;
          bottom: -5px;
          left: 50%;
          width: 9px;
          height: 9px;
          background: inherit;
          border-right: 2px solid rgba(255,255,255,0.92);
          border-bottom: 2px solid rgba(255,255,255,0.92);
          transform: translateX(-50%) rotate(45deg);
          border-radius: 0 0 3px 0;
          z-index: -1;
        }
        .pin-icon { pointer-events: none; display: inline-flex; }
        .pin.dragging .pin-circle { transition: none; }
        .pin.animating { transition: transform 0.7s cubic-bezier(0.25, 0.85, 0.3, 1); }
        .pin.animating .pin-circle { transition: background-color 0.7s ease; }
        .pin-label {
          position: absolute;
          top: ${hit / 2 + pinSize / 2 + 5}px;
          left: 50%;
          transform: translateX(-50%);
          max-width: 96px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding: 2px 8px;
          border-radius: 10px;
          background: rgba(8,8,10,0.9);
          border: 1px solid rgba(255,255,255,0.16);
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
          font-size: 11px;
          font-weight: 500;
          color: #fff;
          pointer-events: none;
          user-select: none;
          -webkit-user-select: none;
          opacity: 0;
          transition: opacity 0.18s ease;
          z-index: 5;
        }
        /* de-clutter: labels appear only for the selected / dragged / pressed
           pins (and collapsed group reps); everything else stays clean */
        .pin.show-label .pin-label,
        .pin.dragging .pin-label,
        .pin.pressing .pin-label { opacity: 1; }
        /* inside an open ring, suppress the auto labels and show only the pin
           you're actually touching, so a dozen names don't pile up */
        .pins.ring-open .pin.show-label .pin-label { opacity: 0; }
        .pins.ring-open .pin.dragging .pin-label,
        .pins.ring-open .pin.pressing .pin-label { opacity: 1; }
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
          font-weight: 700;
          align-items: center;
          justify-content: center;
          box-shadow: 0 1px 3px rgba(0,0,0,0.5);
          pointer-events: none;
          z-index: 2;
        }
        .pin-badge.show { display: flex; }
        .toolbar {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          margin-top: 16px;
          flex-wrap: wrap;
        }
        .mode-toggle {
          display: ${cfg.show_white_toggle ? "inline-flex" : "none"};
          gap: 2px;
          padding: 3px;
          border-radius: 22px;
          background: rgba(255,255,255,0.08);
          width: fit-content;
        }
        .mode-btn {
          width: 40px;
          height: 30px;
          border: none;
          border-radius: 18px;
          background: transparent;
          cursor: pointer;
          padding: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--primary-text-color, #e1e1e1);
        }
        .mode-btn .swatch {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          box-sizing: border-box;
          border: 2px solid rgba(255,255,255,0.85);
        }
        .mode-btn.color .swatch {
          background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red);
        }
        .mode-btn.white .swatch {
          background: linear-gradient(180deg, #ffb15e, #fff3e0 50%, #cfe4ff);
        }
        .mode-btn.fx { display: none; --mdc-icon-size: 20px; }
        .mode-btn.fx.available { display: inline-flex; }
        .mode-btn.active { background: rgba(255,255,255,0.22); }
        .swatches {
          display: ${cfg.show_swatches === false ? "none" : "flex"};
          align-items: center;
          gap: 7px;
          flex-wrap: wrap;
          justify-content: center;
          margin-top: 14px;
        }
        .swatch-btn {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.6);
          padding: 0;
          cursor: pointer;
          box-shadow: 0 1px 3px rgba(0,0,0,0.4);
        }
        .swatch-btn.rnd {
          background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #fff;
          --mdc-icon-size: 15px;
        }
        .effects-panel {
          display: none;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: center;
          margin-top: 12px;
        }
        .effects-panel.open { display: flex; }
        .effect-chip {
          font: inherit;
          font-size: 12px;
          color: var(--primary-text-color, #e1e1e1);
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 14px;
          padding: 5px 11px;
          cursor: pointer;
        }
        .effect-chip:hover { background: rgba(255,255,255,0.16); }
        .brightness {
          display: ${cfg.show_brightness ? "flex" : "none"};
          align-items: center;
          gap: 12px;
          margin-top: 16px;
        }
        .brightness ha-icon { color: var(--secondary-text-color, #9e9e9e); --mdc-icon-size: 20px; }
        .brightness-label {
          font-size: 13px;
          color: var(--secondary-text-color, #9e9e9e);
          min-width: 64px;
          max-width: 130px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .bright-pct {
          font-size: 13px;
          font-variant-numeric: tabular-nums;
          color: var(--secondary-text-color, #9e9e9e);
          min-width: 34px;
          text-align: right;
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
          height: 10px;
          border-radius: 5px;
          background: linear-gradient(to right, #3a3a3a, #ffe9b0);
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 22px;
          height: 22px;
          margin-top: -6px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 5px rgba(0,0,0,0.6);
        }
        input[type="range"]::-moz-range-track {
          height: 10px;
          border-radius: 5px;
          background: linear-gradient(to right, #3a3a3a, #ffe9b0);
        }
        input[type="range"]::-moz-range-thumb {
          width: 22px;
          height: 22px;
          border: none;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 5px rgba(0,0,0,0.6);
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
        .save-form input, .pop-rename input {
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
        /* long-press popover for a single light or a group */
        .pop-backdrop {
          position: absolute;
          inset: 0;
          z-index: 40;
          background: rgba(0,0,0,0.25);
        }
        .pop-backdrop[hidden] { display: none; }
        .popover {
          position: absolute;
          z-index: 41;
          min-width: 210px;
          max-width: 260px;
          padding: 14px;
          border-radius: 16px;
          background: var(--card-background-color, #2a2a2c);
          box-shadow: 0 10px 36px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06);
          color: var(--primary-text-color, #e1e1e1);
          box-sizing: border-box;
        }
        .popover[hidden] { display: none; }
        .pop-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .pop-title { font-size: 15px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pop-power {
          border: none; cursor: pointer; border-radius: 50%;
          width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
          background: rgba(255,255,255,0.1); color: var(--primary-text-color, #e1e1e1);
          --mdc-icon-size: 20px;
        }
        .pop-power.on { background: var(--primary-color, #f5c518); color: #1a1a1a; }
        .pop-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
        .pop-rename { display: flex; gap: 6px; margin-top: 10px; }
        .pop-rename input { width: 100%; }
        .pop-actions { display: flex; gap: 8px; margin-top: 12px; }
        .pop-btn {
          flex: 1; font: inherit; font-size: 13px; cursor: pointer;
          color: var(--primary-text-color, #e1e1e1);
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 10px; padding: 8px;
        }
        .pop-btn:hover { background: rgba(255,255,255,0.16); }
      </style>
      <ha-card>
        <div class="card-header"><ha-icon icon="${cfg.icon || "mdi:lightbulb-group"}"></ha-icon><span class="hdr-text"></span></div>
        <div class="wheel-wrap">
          <canvas></canvas>
          <div class="expand-tray" hidden></div>
          <div class="pins"></div>
          <div class="value-readout"></div>
        </div>
        <div class="toolbar">
          <div class="mode-toggle">
            <button class="mode-btn color active" title="Color"><span class="swatch"></span></button>
            <button class="mode-btn white" title="White / temperature"><span class="swatch"></span></button>
            <button class="mode-btn fx" title="Effects"><ha-icon icon="mdi:auto-fix"></ha-icon></button>
          </div>
        </div>
        <div class="effects-panel"></div>
        <div class="swatches"></div>
        <div class="brightness">
          <ha-icon icon="mdi:brightness-6"></ha-icon>
          <span class="brightness-label">All lights</span>
          <input type="range" min="1" max="100" value="100" aria-label="Brightness">
          <span class="bright-pct">100%</span>
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
        <div class="pop-backdrop" hidden></div>
        <div class="popover" hidden></div>
      </ha-card>
    `;

    this._wheelWrap = this.shadowRoot.querySelector(".wheel-wrap");
    this._canvas = this.shadowRoot.querySelector("canvas");
    this._trayEl = this.shadowRoot.querySelector(".expand-tray");
    this._pinsEl = this.shadowRoot.querySelector(".pins");
    this._readoutEl = this.shadowRoot.querySelector(".value-readout");
    this._modeColorBtn = this.shadowRoot.querySelector(".mode-btn.color");
    this._modeWhiteBtn = this.shadowRoot.querySelector(".mode-btn.white");
    this._modeFxBtn = this.shadowRoot.querySelector(".mode-btn.fx");
    this._effectsPanel = this.shadowRoot.querySelector(".effects-panel");
    this._swatchesEl = this.shadowRoot.querySelector(".swatches");
    this._hdrText = this.shadowRoot.querySelector(".hdr-text");
    this._popBackdrop = this.shadowRoot.querySelector(".pop-backdrop");
    this._popover = this.shadowRoot.querySelector(".popover");
    this._modeColorBtn.addEventListener("click", () => this._setMode("color"));
    this._modeWhiteBtn.addEventListener("click", () => this._setMode("white"));
    this._modeFxBtn.addEventListener("click", () => this._toggleEffectsPanel());
    this._popBackdrop.addEventListener("pointerdown", () => this._closePopover());
    this._brightnessLabel = this.shadowRoot.querySelector(".brightness-label");
    this._slider = this.shadowRoot.querySelector('input[type="range"]');
    this._brightPct = this.shadowRoot.querySelector(".bright-pct");
    this._ctNote = this.shadowRoot.querySelector(".ct-note");

    this._chipsEl = this.shadowRoot.querySelector(".chips");
    this._saveBtn = this.shadowRoot.querySelector(".save-btn");
    this._saveForm = this.shadowRoot.querySelector(".save-form");
    this._saveInput = this.shadowRoot.querySelector(".save-form input");

    this._hdrText.textContent = this._headerTitle();
    this._renderSwatches();

    this._slider.addEventListener("input", () => this._onBrightnessInput());
    this._wheelWrap.addEventListener("pointerdown", (ev) => {
      // tap on empty wheel area: close a ring, place the current selection at
      // the tapped point, or clear the selection
      if (ev.target === this._canvas) this._onWheelTap(ev);
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
      const icon = document.createElement("ha-icon");
      icon.className = "pin-icon";
      circle.appendChild(icon);
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
      this._pins.set(light.entity, { el: pin, circle, icon, badge, label, cfg: light });
    }

    this._renderPresets();
    this._restoreStore(); // async; re-renders presets/clusters when loaded

    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this._wheelWrap);
    this._onResize();
  }

  _headerTitle() {
    const cfg = this._config;
    if (typeof cfg.title === "string") return cfg.title;
    if (cfg.auto_entities?.area) {
      const areas = this._hass.areas || {};
      const a = Object.values(areas).find(
        (ar) =>
          ar.area_id === cfg.auto_entities.area ||
          (ar.name || "").toLowerCase() === String(cfg.auto_entities.area).toLowerCase()
      );
      if (a) return a.name;
    }
    return "Lights";
  }

  /* ------------------------------------------------- icons / swatches / fx */

  _pinIcon(entity) {
    const a = this._hass.states[entity]?.attributes || {};
    if (a.icon) return a.icon;
    const modes = a.supported_color_modes || [];
    // a strip-like light gets a strip icon, everything else a bulb
    if (a.effect_list && modes.includes("rgbww")) return "mdi:led-strip-variant";
    return "mdi:lightbulb";
  }

  _renderSwatches() {
    if (!this._swatchesEl) return;
    this._swatchesEl.textContent = "";
    const list = Array.isArray(this._config.swatches)
      ? this._config.swatches
      : DEFAULT_SWATCHES;
    for (const sw of list) {
      const hs = Array.isArray(sw) ? sw : [Number(sw) || 0, 100];
      const btn = document.createElement("button");
      btn.className = "swatch-btn";
      btn.style.background = rgbCss(hsv2rgb(hs[0], hs[1] / 100, 1));
      btn.title = "Apply color";
      btn.addEventListener("click", () => this._applySwatch(hs));
      this._swatchesEl.appendChild(btn);
    }
    const rnd = document.createElement("button");
    rnd.className = "swatch-btn rnd";
    rnd.title = "Randomize";
    rnd.innerHTML = '<ha-icon icon="mdi:dice-multiple"></ha-icon>';
    rnd.addEventListener("click", () => this._randomize());
    this._swatchesEl.appendChild(rnd);
  }

  /** Apply a fixed hue/sat to the current selection (or all on lights). */
  _applySwatch(hs) {
    if (this._mode === "white") this._setMode("color");
    const targets = this._brightnessTargets();
    const ids = targets.size ? [...targets] : this._onLightIds();
    for (const id of ids) {
      this._lastHs.set(id, hs.slice());
      this._sendColor(id, hs);
    }
    // keep any selected stacks coherent
    for (const cluster of this._clusters) {
      if (cluster.members.some((mm) => ids.includes(mm))) cluster.hs = hs.slice();
    }
    this._haptic(10);
    this._scheduleSave();
    this._updateAll();
  }

  _randomize() {
    if (this._mode === "white") this._setMode("color");
    const targets = this._brightnessTargets();
    const ids = targets.size ? [...targets] : this._onLightIds();
    for (const id of ids) {
      const hs = [Math.round(Math.random() * 360), 70 + Math.round(Math.random() * 30)];
      this._lastHs.set(id, hs);
      this._sendColor(id, hs);
    }
    this._haptic(15);
    this._scheduleSave();
    this._updateAll();
  }

  _onLightIds() {
    return [...this._pins.keys()].filter(
      (e) => this._hass.states[e]?.state === "on"
    );
  }

  _allEffects() {
    const set = new Set();
    for (const entity of this._pins.keys()) {
      const list = this._hass.states[entity]?.attributes?.effect_list;
      if (Array.isArray(list)) list.forEach((e) => e && set.add(e));
    }
    return [...set];
  }

  _toggleEffectsPanel() {
    this._effectsOpen = !this._effectsOpen;
    if (this._effectsOpen) this._renderEffects();
    this._effectsPanel.classList.toggle("open", this._effectsOpen);
    this._modeFxBtn.classList.toggle("active", this._effectsOpen);
  }

  _renderEffects() {
    this._effectsPanel.textContent = "";
    for (const name of this._allEffects()) {
      const chip = document.createElement("button");
      chip.className = "effect-chip";
      chip.textContent = name;
      chip.addEventListener("click", () => this._applyEffect(name));
      this._effectsPanel.appendChild(chip);
    }
  }

  /** Apply an effect to the selection (or all on lights that support it). */
  _applyEffect(name) {
    const targets = this._brightnessTargets();
    const base = targets.size ? [...targets] : this._onLightIds();
    const ids = base.filter((e) =>
      (this._hass.states[e]?.attributes?.effect_list || []).includes(name)
    );
    if (ids.length) {
      this._hass.callService("light", "turn_on", { entity_id: ids, effect: name });
      this._haptic(10);
    }
  }

  _haptic(ms) {
    if (!this._config.enable_haptics) return;
    try {
      if (navigator && typeof navigator.vibrate === "function") navigator.vibrate(ms);
    } catch (e) {
      /* unsupported */
    }
  }

  _showReadout(text) {
    if (!this._readoutEl) return;
    this._readoutEl.textContent = text;
    this._readoutEl.classList.add("show");
  }

  _hideReadout() {
    this._readoutEl?.classList.remove("show");
  }

  /** Tap on the empty wheel: close a ring, place a selection, or clear it. */
  _onWheelTap(ev) {
    if (this._expandedCluster) {
      this._closeCluster();
      return;
    }
    const targets = this._brightnessTargets();
    if (targets.size) {
      // tap-to-place: send the selected lights to the tapped value
      const rect = this._wheelWrap.getBoundingClientRect();
      const r = rect.width / 2;
      const x = ev.clientX - (rect.left + r);
      const y = ev.clientY - (rect.top + r);
      const d = Math.hypot(x, y);
      const cx = d > r && d > 0 ? (x * r) / d : x;
      const cy = d > r && d > 0 ? (y * r) / d : y;
      for (const id of targets) {
        if (this._mode === "white") {
          const k = yToTemp(cy, r);
          this._lastTemp.set(id, k);
          this._whiteX.set(id, cx);
          this._sendTemp(id, k);
        } else {
          const hs = xyToHs(cx, cy, r);
          this._lastHs.set(id, hs);
          this._sendColor(id, hs);
        }
      }
      for (const cluster of this._clusters) {
        if (cluster.members.every((mm) => targets.has(mm))) {
          if (this._mode === "white") {
            cluster.temp = yToTemp(cy, r);
            cluster.whiteX = cx;
          } else {
            cluster.hs = xyToHs(cx, cy, r);
          }
        }
      }
      this._haptic(10);
      this._scheduleSave();
      this._updateAll();
      return;
    }
    this._multi.clear();
    this._selectedCluster = null;
    this._refreshSelection();
  }

  /* ----------------------------------------------- long-press popover */

  /** Open the per-light or per-group control popover for a pin. */
  _openPopover(entity, isExtract) {
    const cluster = isExtract ? null : this._clusterFor(entity);
    const isGroup = !!cluster;
    const ids = isGroup ? [...cluster.members] : [entity];
    this._popoverFor = { ids, cluster, entity };

    const title = isGroup
      ? this._groupName(cluster)
      : this._pins.get(entity)?.cfg.label ||
        this._hass.states[entity]?.attributes.friendly_name ||
        entity;
    const anyOn = ids.some((e) => this._hass.states[e]?.state === "on");
    const b = this._groupBrightnessPct(ids);

    const pop = this._popover;
    pop.innerHTML = `
      <div class="pop-head">
        <span class="pop-title"></span>
        <button class="pop-power ${anyOn ? "on" : ""}" title="Toggle"><ha-icon icon="mdi:power"></ha-icon></button>
      </div>
      <div class="pop-row">
        <ha-icon icon="mdi:brightness-6" style="color:var(--secondary-text-color,#9e9e9e)"></ha-icon>
        <input class="pop-bright" type="range" min="1" max="100" value="${b}">
      </div>
      ${isGroup ? `<div class="pop-rename"><input type="text" maxlength="24" placeholder="Group name"><button class="pop-btn pop-rename-ok">Save</button></div>` : ""}
      <div class="pop-actions">
        ${isGroup ? `<button class="pop-btn pop-ungroup">Ungroup</button>` : `<button class="pop-btn pop-details">Details</button>`}
      </div>
    `;
    pop.querySelector(".pop-title").textContent = title;
    pop.querySelector(".pop-power").addEventListener("click", () => {
      this._hass.callService("light", anyOn ? "turn_off" : "turn_on", { entity_id: ids });
      this._haptic(10);
      this._closePopover();
    });
    pop.querySelector(".pop-bright").addEventListener("input", (e) => {
      const onIds = ids.filter((id) => this._hass.states[id]?.state === "on");
      this._hass.callService("light", "turn_on", {
        entity_id: onIds.length ? onIds : ids,
        brightness_pct: Number(e.target.value),
      });
    });
    if (isGroup) {
      const nameInput = pop.querySelector(".pop-rename input");
      nameInput.value = cluster.name || "";
      const saveName = () => {
        cluster.name = nameInput.value.trim() || null;
        this._scheduleSave();
        this._updateAll();
        this._closePopover();
      };
      pop.querySelector(".pop-rename-ok").addEventListener("click", saveName);
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveName();
      });
      pop.querySelector(".pop-ungroup").addEventListener("click", () => {
        this._clusters = this._clusters.filter((c) => c !== cluster);
        this._scheduleSave();
        this._updateAll();
        this._closePopover();
      });
    } else {
      pop.querySelector(".pop-details").addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("hass-more-info", {
            detail: { entityId: entity },
            bubbles: true,
            composed: true,
          })
        );
        this._closePopover();
      });
    }

    pop.hidden = false;
    this._popBackdrop.hidden = false;
    this._positionPopover(entity);
  }

  _positionPopover(entity) {
    const pop = this._popover;
    const card = this.shadowRoot.querySelector("ha-card");
    const pinEl = this._pins.get(entity)?.el;
    if (!card || !pinEl) return;
    const cardR = card.getBoundingClientRect();
    const pinR = pinEl.getBoundingClientRect();
    const popW = pop.offsetWidth || 220;
    const popH = pop.offsetHeight || 160;
    let left = pinR.left - cardR.left + pinR.width / 2 - popW / 2;
    left = Math.max(8, Math.min(left, cardR.width - popW - 8));
    let top = pinR.bottom - cardR.top + 8;
    if (top + popH > cardR.height) top = pinR.top - cardR.top - popH - 8;
    top = Math.max(8, top);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  _closePopover() {
    this._popoverFor = null;
    if (this._popover) this._popover.hidden = true;
    if (this._popBackdrop) this._popBackdrop.hidden = true;
  }

  _groupBrightnessPct(ids) {
    const vals = [];
    for (const id of ids) {
      const s = this._hass.states[id];
      if (s?.state === "on" && s.attributes.brightness != null) {
        vals.push((s.attributes.brightness / 255) * 100);
      }
    }
    return vals.length
      ? Math.max(1, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length))
      : 100;
  }

  /* ------------------------------------------------------------ wheel */

  _onResize() {
    const rect = this._wheelWrap.getBoundingClientRect();
    const size = Math.round(rect.width);
    if (!size || size === this._renderedSize) {
      this._radius = size / 2;
      this._positionAllPins();
      if (this._expandedCluster) this._openCluster(this._expandedCluster);
      return;
    }
    this._renderedSize = size;
    this._radius = size / 2;
    this._drawWheel(size);
    this._positionAllPins();
    if (this._expandedCluster) this._openCluster(this._expandedCluster);
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
    const white = this._mode === "white";
    // precompute the white-mode vertical gradient (warm top -> cool bottom)
    let tempRow = null;
    if (white) {
      tempRow = new Array(px);
      for (let y = 0; y < px; y++) {
        const frac = y / (px - 1);
        tempRow[y] = kelvinToRgb(TEMP_MIN_K + frac * (TEMP_MAX_K - TEMP_MIN_K));
      }
    }
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = x - c;
        const dy = y - c;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const i = (y * px + x) * 4;
        if (dist > r + 1) continue; // transparent outside
        let rr, gg, bb;
        if (white) {
          [rr, gg, bb] = tempRow[y];
        } else {
          let hue = (Math.atan2(-dy, dx) * 180) / Math.PI;
          if (hue < 0) hue += 360;
          const sat = Math.min(dist / r, 1);
          [rr, gg, bb] = hsv2rgb(hue, sat, 1);
        }
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
      if (stateObj && !this._supportsMode(stateObj)) {
        pin.el.style.display = "none";
        unsupported.push(stateObj.attributes.friendly_name || entity);
        continue;
      }
      pin.el.style.display = "";
      this._updatePin(entity, pin, stateObj);
    }
    this._ctNote.hidden = unsupported.length === 0;
    if (unsupported.length) {
      const what = this._mode === "white" ? "no white/temperature support" : "no color support";
      this._ctNote.textContent = `Not shown (${what}): ${unsupported.join(", ")}`;
    }
    // effects toggle only appears if some light advertises effects
    if (this._modeFxBtn) {
      this._modeFxBtn.classList.toggle(
        "available",
        this._config.show_effects && this._allEffects().length > 0
      );
    }
    this._updateWheelBrightness();
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
    const kelvin = exists && stateObj.attributes.color_temp_kelvin;
    if (isOn && kelvin) {
      if (this._lastTemp.get(entity) !== kelvin) {
        this._lastTemp.set(entity, kelvin);
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

    // Groups are sticky: membership changes only when you explicitly merge
    // two pins or drag one out of an open ring. A light turning on/off or
    // being recolored elsewhere does NOT remove it from its group, so you
    // never have to rebuild groups after an external change.
    const cluster = this._clusterFor(entity);

    const collapsedRep =
      cluster && cluster !== this._expandedCluster && cluster.members[0] === entity;
    const ringMember = cluster && cluster === this._expandedCluster;

    if (pin.label) {
      const own = pin.cfg.label || (exists && stateObj.attributes.friendly_name) || entity;
      // open ring: each pin shows its own name; collapsed stack: group name
      pin.label.textContent = collapsedRep ? this._groupName(cluster) : own;
      // de-clutter: only selected / ring / collapsed-group pins show a label
      pin.el.classList.toggle(
        "show-label",
        this._multi.has(entity) || ringMember || collapsedRep
      );
    }

    if (dragging) return; // don't fight the user's finger
    // a ring member's position is owned by the layout / its extract drag
    if (ringMember) return;

    const [x, y] = this._pinXY(entity, cluster);
    pin.el.style.transform = `translate(${this._radius + x}px, ${this._radius + y}px)`;

    if (unavailable) {
      pin.circle.style.background = "#555";
      pin.icon.setAttribute("icon", "mdi:alert-circle-outline");
      pin.icon.style.color = "rgba(255,255,255,0.9)";
    } else {
      const rgb = this._pinRgb(entity, stateObj, cluster);
      pin.circle.style.background = rgbCss(rgb);
      pin.icon.setAttribute("icon", collapsedRep ? "mdi:lightbulb-group" : this._pinIcon(entity));
      pin.icon.style.color = this._contrastColor(rgb);
    }
  }

  /** Black or white, whichever reads better on the given rgb fill. */
  _contrastColor(rgb) {
    const [r, g, b] = rgb;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.95)";
  }

  _positionPin(pin, hs) {
    const r = this._radius;
    if (!r) return;
    const [x, y] = hsToXy(hs[0], hs[1], r);
    pin.el.style.transform = `translate(${r + x}px, ${r + y}px)`;
  }

  /** Wheel-local [x, y] of a cluster's shared value in the current mode. */
  _clusterXY(cluster) {
    const r = this._radius;
    if (this._mode === "white") {
      return [cluster.whiteX ?? 0, tempToY(cluster.temp || DEFAULT_TEMP_K, r)];
    }
    return hsToXy(cluster.hs[0], cluster.hs[1], r);
  }

  /** Fill color of a cluster's shared value in the current mode. */
  _clusterRgb(cluster) {
    if (this._mode === "white") return kelvinToRgb(cluster.temp || DEFAULT_TEMP_K);
    return hsv2rgb(cluster.hs[0], cluster.hs[1] / 100, 1);
  }

  /** Custom name if set, else a generic "Group N". */
  _groupName(cluster) {
    return cluster.name || `Group ${cluster.no || "?"}`;
  }

  /** Wheel-local [x, y] for a pin in the current mode. */
  _pinXY(entity, cluster) {
    const r = this._radius;
    if (cluster) return this._clusterXY(cluster);
    if (this._mode === "white") {
      const k = this._lastTemp.get(entity) || DEFAULT_TEMP_K;
      let x = this._whiteX.get(entity);
      if (x == null) x = this._defaultWhiteX(entity);
      return [x, tempToY(k, r)];
    }
    const hs = this._lastHs.get(entity) || [0, 0];
    return hsToXy(hs[0], hs[1], r);
  }

  /** Fill color for a pin in the current mode. */
  _pinRgb(entity, stateObj, cluster) {
    if (cluster) return this._clusterRgb(cluster);
    const isOn = stateObj && stateObj.state === "on";
    if (this._mode === "white") {
      return kelvinToRgb(this._lastTemp.get(entity) || DEFAULT_TEMP_K);
    }
    if (isOn && Array.isArray(stateObj.attributes.rgb_color)) {
      return stateObj.attributes.rgb_color;
    }
    const hs = this._lastHs.get(entity) || [0, 0];
    return hsv2rgb(hs[0], hs[1] / 100, 1);
  }

  /** Spread white-mode pins horizontally by index so they don't fully overlap. */
  _defaultWhiteX(entity) {
    const ids = this._lights.map((l) => l.entity);
    const i = ids.indexOf(entity);
    const n = Math.max(ids.length, 1);
    const span = this._radius * 0.7;
    return n > 1 ? -span / 2 + (span * i) / (n - 1) : 0;
  }

  _positionAllPins() {
    for (const [entity, pin] of this._pins) {
      if (this._drag && this._drag.members.has(entity)) continue;
      // members of an open ring are positioned by _layoutExpanded, not here
      if (this._expandedCluster && this._expandedCluster.members.includes(entity)) continue;
      const cluster = this._clusterFor(entity);
      const [x, y] = this._pinXY(entity, cluster);
      pin.el.style.transform = `translate(${this._radius + x}px, ${this._radius + y}px)`;
    }
  }

  /* ------------------------------------------------------------ dragging */

  _onPinDown(ev, entity) {
    const pin = this._pins.get(entity);
    if (!pin || pin.el.classList.contains("unavailable")) return;
    // ignore non-primary touches (a second finger landing mid-drag would
    // otherwise hijack the gesture on mobile)
    if (this._drag) return;
    ev.preventDefault();
    ev.stopPropagation();

    // When a ring is open and you grab one of its members, this is an
    // "extract" drag: only that pin moves, and dropping it clear of the well
    // removes it from the group.
    const extract =
      this._expandedCluster && this._expandedCluster.members.includes(entity);

    if (extract) {
      // pressing a ring member surfaces just its name (others stay clean)
      for (const p of this._pins.values()) p.el.classList.remove("pressing");
      pin.el.classList.add("pressing");
    }

    let group;
    const startXy = new Map();
    if (extract) {
      group = [entity];
      const slot = this._expand?.slots.get(entity) || this._clusterXY(this._expandedCluster);
      startXy.set(entity, slot);
    } else {
      // dragging a selected pin moves the whole selection together; cluster
      // members always come along with their stack
      const seeds =
        this._multi.has(entity) && this._multi.size > 1 ? [...this._multi] : [entity];
      group = [];
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
      for (const id of group) {
        const cluster = this._clusterFor(id);
        startXy.set(id, cluster ? this._clusterXY(cluster) : this._pinXY(id, null));
      }
    }

    // Mobile reliability: we use BOTH pointer capture and window-level
    // listeners.
    //   - setPointerCapture keeps the gesture owned by the pin and stops the
    //     browser from re-hit-testing each move and hijacking it into a page
    //     scroll once the finger leaves the wheel (which fires pointercancel
    //     and silently kills the drag — the main mobile bug).
    //   - window listeners guarantee we still hear pointermove/up even if
    //     capture delivery to a shadow-DOM child is flaky on iOS Safari.
    // Captured events still bubble to window, so the handler runs once.
    try {
      pin.el.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* capture unsupported/failed; window listeners still cover us */
    }

    const onMove = (e) => {
      if (!this._drag || e.pointerId !== this._drag.pointerId) return;
      if (e.cancelable) e.preventDefault();
      this._onPinMove(e, entity);
    };
    const onEnd = (e) => {
      if (!this._drag || e.pointerId !== this._drag.pointerId) return;
      // A pointercancel with no movement is an ambiguous interruption — drop
      // it silently rather than firing a tap (which could toggle selection
      // or split a cluster). A pointercancel AFTER real movement commits the
      // last dragged position: on mobile pointercancel can fire spuriously,
      // and aborting a real drag would make it feel random.
      if (e.type === "pointercancel" && !this._drag.moved) {
        this._abortDrag();
        return;
      }
      cleanup();
      this._onPinUp(e, entity);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      try {
        pin.el.releasePointerCapture(ev.pointerId);
      } catch (e) {
        /* already released */
      }
    };

    this._drag = {
      entity,
      members: new Set(group),
      extract,
      cluster: extract ? this._expandedCluster : null,
      willRemove: false,
      startXy,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: false,
      mergeTarget: null,
      lastHs: new Map(),
      lastTemp: new Map(),
      cleanup,
    };

    // hold without moving -> open the per-light/group control popover
    clearTimeout(this._longPressTimer);
    this._longPressTimer = setTimeout(() => {
      if (this._drag && !this._drag.moved && this._drag.entity === entity) {
        this._haptic(20);
        const wasExtract = this._drag.extract;
        this._abortDrag();
        this._openPopover(entity, wasExtract);
      }
    }, LONG_PRESS_MS);

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  _abortDrag() {
    const drag = this._drag;
    if (!drag) return;
    clearTimeout(this._longPressTimer);
    this._hideReadout();
    this._pins.get(drag.entity)?.el.classList.remove("pressing");
    if (drag.cleanup) drag.cleanup();
    this._drag = null;
    for (const id of drag.members) {
      this._pins.get(id)?.el.classList.remove("dragging", "removing");
    }
    if (drag.mergeTarget) {
      this._pins.get(drag.mergeTarget)?.el.classList.remove("merge-target");
    }
    // snap pins back to where state thinks they are
    this._positionAllPins();
    if (this._expandedCluster) this._layoutExpanded();
  }

  _onPinMove(ev, entity) {
    const drag = this._drag;
    if (!drag || drag.entity !== entity || ev.pointerId !== drag.pointerId) return;
    const dxp = ev.clientX - drag.startX;
    const dyp = ev.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.sqrt(dxp * dxp + dyp * dyp) < TAP_SLOP_PX) return;
      drag.moved = true;
      clearTimeout(this._longPressTimer); // a real drag cancels the long-press
      for (const id of drag.members) {
        this._pins.get(id).el.classList.add("dragging", "show-label");
      }
    }
    const r = this._radius;
    const white = this._mode === "white";

    if (drag.extract) {
      // single pin follows the finger; it leaves the group if pulled clear
      const { x, y } = this._dragPoint(drag, entity, dxp, dyp, r);
      this._applyDragValue(drag, entity, x, y, r);
      const ex = this._expand;
      const outside =
        ex && Math.hypot(x - ex.cx, y - ex.cy) > ex.trayR + this._config.pin_size;
      drag.willRemove = !!outside;
      this._pins.get(entity).el.classList.toggle("removing", drag.willRemove);
      return;
    }

    let pressedX = 0;
    let pressedY = 0;
    for (const id of drag.members) {
      const { x, y } = this._dragPoint(drag, id, dxp, dyp, r);
      if (id === entity) {
        pressedX = x;
        pressedY = y;
      }
      this._applyDragValue(drag, id, x, y, r);
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

  /** Clamp a member's start position + pointer delta to inside the wheel. */
  _dragPoint(drag, id, dxp, dyp, r) {
    const [sx, sy] = drag.startXy.get(id);
    let x = sx + dxp;
    let y = sy + dyp;
    const d = Math.sqrt(x * x + y * y);
    if (d > r && d > 0) {
      x *= r / d;
      y *= r / d;
    }
    return { x, y };
  }

  /** Move a pin during a drag and record its value for the active mode. */
  _applyDragValue(drag, id, x, y, r) {
    const pin = this._pins.get(id);
    pin.el.style.transform = `translate(${r + x}px, ${r + y}px)`;
    pin.el.classList.remove("off");
    if (this._mode === "white") {
      const k = yToTemp(y, r);
      drag.lastTemp.set(id, k);
      this._whiteX.set(id, x);
      const rgb = kelvinToRgb(k);
      pin.circle.style.background = rgbCss(rgb);
      pin.icon.style.color = this._contrastColor(rgb);
      this._throttledColorCall(id, k);
      if (id === drag.entity) this._showReadout(`${k} K`);
    } else {
      const hs = xyToHs(x, y, r);
      drag.lastHs.set(id, hs);
      const rgb = hsv2rgb(hs[0], hs[1] / 100, 1);
      pin.circle.style.background = rgbCss(rgb);
      pin.icon.style.color = this._contrastColor(rgb);
      this._throttledColorCall(id, hs);
      if (id === drag.entity) this._showReadout(`${Math.round(hs[0])}° · ${Math.round(hs[1])}%`);
    }
  }

  _onPinUp(ev, entity) {
    const drag = this._drag;
    if (!drag || drag.entity !== entity) return;
    this._drag = null;
    clearTimeout(this._longPressTimer);
    this._hideReadout();
    for (const id of drag.members) {
      this._pins.get(id).el.classList.remove("dragging");
    }
    // the pressed name is only up while the finger is down
    this._pins.get(entity)?.el.classList.remove("pressing");
    if (drag.mergeTarget) {
      this._pins.get(drag.mergeTarget)?.el.classList.remove("merge-target");
      this._haptic(12); // merge about to happen
    }

    if (!drag.moved) {
      this._onPinTap(entity);
      return;
    }

    const white = this._mode === "white";

    if (drag.extract) {
      this._pins.get(entity).el.classList.remove("removing");
      const cluster = drag.cluster;
      if (drag.willRemove) {
        // pulled clear of the well: leave the group at the dropped value
        this._removeFromCluster(entity);
        this._commitDragValue(drag, entity);
        this._scheduleSave();
        if (!this._clusters.includes(cluster) || cluster.members.length < 2) {
          this._closeCluster(); // fewer than 2 left — stack dissolved
        } else {
          this._layoutExpanded(); // reflow the pins that stayed
        }
      } else {
        // dropped back inside: stays in the group at the stack value
        if (white) {
          this._lastTemp.set(entity, cluster.temp || DEFAULT_TEMP_K);
          this._sendTemp(entity, cluster.temp || DEFAULT_TEMP_K);
        } else {
          this._lastHs.set(entity, cluster.hs.slice());
          this._sendColor(entity, cluster.hs);
        }
        cluster.settleUntil = Date.now() + CLUSTER_SETTLE_MS;
        this._layoutExpanded();
      }
      return;
    }

    if (drag.mergeTarget) {
      // dropped onto another pin: snap the dragged lights into its stack
      this._mergeInto(drag.mergeTarget, drag.members);
      return;
    }

    for (const id of drag.members) this._commitDragValue(drag, id);
    // clusters dragged as a whole keep their stacked value; restart the
    // settle window so stale echoes from this drag can't dissolve them
    for (const cluster of this._clusters) {
      if (cluster.members.every((m) => drag.members.has(m))) {
        const rep = cluster.members[0];
        if (white) {
          const k = drag.lastTemp.get(rep);
          if (k != null) cluster.temp = k;
          const x = this._whiteX.get(rep);
          if (x != null) cluster.whiteX = x;
        } else {
          const hs = drag.lastHs.get(rep);
          if (hs) cluster.hs = hs.slice();
        }
        cluster.settleUntil = Date.now() + CLUSTER_SETTLE_MS;
      }
    }
    this._scheduleSave();
  }

  /** Persist + send a member's final dragged value for the active mode. */
  _commitDragValue(drag, id) {
    if (this._mode === "white") {
      const k = drag.lastTemp.get(id);
      if (k != null) {
        this._lastTemp.set(id, k);
        this._sendTemp(id, k);
      }
    } else {
      const hs = drag.lastHs.get(id);
      if (hs) {
        this._lastHs.set(id, hs);
        this._sendColor(id, hs);
      }
    }
  }

  _onPinTap(entity) {
    // While a ring is open, tapping a member just selects it for brightness;
    // tapping anything else closes the ring.
    if (this._expandedCluster) {
      if (this._expandedCluster.members.includes(entity)) {
        this._selectedCluster = null;
        this._multi = new Set([entity]);
        this._refreshSelection();
      } else {
        this._closeCluster();
      }
      return;
    }
    const cluster = this._clusterFor(entity);
    if (cluster) {
      // open the stack into a ring you can pull pins out of (Hue-style)
      this._openCluster(cluster);
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

  /* ------------------------------------------------- open / close a ring */

  _openCluster(cluster) {
    if (this._expandedCluster && this._expandedCluster !== cluster) this._closeCluster();
    this._expandedCluster = cluster;
    this._pinsEl?.classList.add("ring-open");
    const r = this._radius;
    // size the well so the members spread comfortably around its rim
    const n = cluster.members.length;
    const needed = (n * this._config.pin_size * 1.5) / (2 * Math.PI);
    const trayR = Math.min(Math.max(r * 0.4, 56, needed), r - this._config.pin_size);
    // centre the well on the stack's value, clamped to stay inside the wheel
    let [cx, cy] = this._clusterXY(cluster);
    const mag = Math.hypot(cx, cy);
    const maxMag = Math.max(0, r - trayR - 4);
    if (mag > maxMag && mag > 0) {
      cx *= maxMag / mag;
      cy *= maxMag / mag;
    }
    this._expand = { cluster, cx, cy, trayR, slots: new Map() };
    if (this._trayEl) {
      this._trayEl.hidden = false;
      this._trayEl.style.width = `${2 * trayR}px`;
      this._trayEl.style.height = `${2 * trayR}px`;
      this._trayEl.style.left = `${r + cx}px`;
      this._trayEl.style.top = `${r + cy}px`;
    }
    this._selectedCluster = cluster;
    this._multi = new Set(cluster.members);
    this._refreshClusterStyles();
    this._layoutExpanded();
    this._refreshSelection();
  }

  _layoutExpanded() {
    const ex = this._expand;
    if (!ex) return;
    const r = this._radius;
    const members = ex.cluster.members;
    const n = members.length;
    members.forEach((id, i) => {
      const ang = -Math.PI / 2 + (i / n) * 2 * Math.PI; // first slot at top
      const x = ex.cx + ex.trayR * Math.cos(ang);
      const y = ex.cy + ex.trayR * Math.sin(ang);
      ex.slots.set(id, [x, y]);
      if (this._drag && this._drag.members.has(id)) return; // skip the dragged one
      const pin = this._pins.get(id);
      if (!pin) return;
      pin.el.classList.add("animating");
      pin.el.classList.remove("off", "removing");
      pin.el.style.transform = `translate(${r + x}px, ${r + y}px)`;
      // colour each pin by its own current value so the lights in the ring
      // are distinguishable (not a dozen identical white markers)
      const rgb = this._pinRgb(id, this._hass.states[id], null);
      pin.circle.style.background = rgbCss(rgb);
      pin.icon.setAttribute("icon", this._pinIcon(id));
      pin.icon.style.color = this._contrastColor(rgb);
    });
    clearTimeout(this._animTimer);
    this._animTimer = setTimeout(() => {
      for (const p of this._pins.values()) p.el.classList.remove("animating");
    }, 400);
  }

  _closeCluster() {
    if (!this._expandedCluster) return;
    this._expandedCluster = null;
    this._expand = null;
    this._pinsEl?.classList.remove("ring-open");
    for (const pin of this._pins.values()) pin.el.classList.remove("pressing");
    if (this._trayEl) this._trayEl.hidden = true;
    this._selectedCluster = null;
    this._multi.clear();
    this._refreshClusterStyles();
    this._positionAllPins();
    this._refreshSelection();
    this._updateAll();
  }

  _refreshSelection() {
    for (const [id, pin] of this._pins) {
      const sel = this._multi.has(id);
      pin.el.classList.toggle("selected", sel);
      if (pin.label) {
        const cluster = this._clusterFor(id);
        const ringMember = cluster && cluster === this._expandedCluster;
        const collapsedRep =
          cluster && cluster !== this._expandedCluster && cluster.members[0] === id;
        pin.el.classList.toggle("show-label", sel || ringMember || collapsedRep);
      }
    }
    this._updateBrightnessUi();
  }

  /* ------------------------------------------------- color / white mode */

  _setMode(mode) {
    if (mode !== "color" && mode !== "white") return;
    if (mode === this._mode) return;
    this._applyMode(mode);
    this._multi.clear();
    this._selectedCluster = null;
    this._refreshSelection();
    this._updateAll();
    this._scheduleSave();
  }

  /** Switch the wheel mode and redraw, without persisting (used by restore). */
  _applyMode(mode) {
    this._mode = mode;
    if (this._expandedCluster) this._closeCluster();
    if (this._modeColorBtn) this._modeColorBtn.classList.toggle("active", mode === "color");
    if (this._modeWhiteBtn) this._modeWhiteBtn.classList.toggle("active", mode === "white");
    this._renderedSize = 0; // force the wheel gradient to redraw for the mode
    if (this._built) this._onResize();
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
    this._sendValue(entity, hs);
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

  _sendTemp(entity, kelvin) {
    this._hass.callService("light", "turn_on", {
      entity_id: entity,
      color_temp_kelvin: this._clampKelvin(entity, kelvin),
    });
  }

  /** Clamp a Kelvin value to the light's own supported range when known. */
  _clampKelvin(entity, kelvin) {
    const a = this._hass.states[entity]?.attributes || {};
    const lo = a.min_color_temp_kelvin || TEMP_MIN_K;
    const hi = a.max_color_temp_kelvin || TEMP_MAX_K;
    return Math.round(Math.min(Math.max(kelvin, lo), hi));
  }

  /** Send the current value for the active mode (hs array or Kelvin number). */
  _sendValue(entity, value) {
    if (this._mode === "white") this._sendTemp(entity, value);
    else this._sendColor(entity, value);
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

  /** Snap distance (px between pin centers) for merging two pins. */
  _mergeDistance() {
    const d = this._config.merge_distance;
    return d != null ? d : this._config.pin_size;
  }

  /** Distance a member must move to leave a stack — 2x merge for hysteresis. */
  _strayDistance() {
    return this._mergeDistance() * 2;
  }

  _refreshClusterStyles() {
    const expanded = this._expandedCluster;
    for (const [entity, pin] of this._pins) {
      const cluster = this._clusterFor(entity);
      // the open ring's members each show on the rim (no single badge)
      if (expanded && cluster === expanded) {
        pin.el.classList.remove("cluster-hidden");
        pin.badge.classList.remove("show");
        continue;
      }
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
      const [tx, ty] = cluster ? this._clusterXY(cluster) : this._pinXY(id, null);
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
    // carry both a color and a temperature so the group works in either mode
    const hs = (targetCluster ? targetCluster.hs : this._lastHs.get(targetEntity) || [0, 0]).slice();
    const temp = targetCluster
      ? targetCluster.temp || DEFAULT_TEMP_K
      : this._lastTemp.get(targetEntity) || DEFAULT_TEMP_K;
    const no = targetCluster ? targetCluster.no : ++this._groupSeq;
    const whiteX = targetCluster?.whiteX ?? 0;
    const members = targetCluster ? [...targetCluster.members] : [targetEntity];
    const moved = [...draggedMembers];
    this._clusters = this._clusters.filter(
      (c) => c !== targetCluster && !moved.some((id) => c.members.includes(id))
    );
    for (const id of moved) {
      if (!members.includes(id)) members.push(id);
    }
    const cluster = { members, hs, temp, no, whiteX, settleUntil: Date.now() + CLUSTER_SETTLE_MS };
    this._clusters.push(cluster);
    this._scheduleSave();
    const [cx, cy] = this._clusterXY(cluster);
    const rgb = rgbCss(this._clusterRgb(cluster));
    for (const id of moved) {
      this._lastHs.set(id, hs.slice());
      this._lastTemp.set(id, temp);
      const pin = this._pins.get(id);
      pin.el.classList.add("animating");
      pin.el.style.transform = `translate(${this._radius + cx}px, ${this._radius + cy}px)`;
      pin.circle.style.background = rgb;
      if (this._mode === "white") this._sendTemp(id, temp);
      else this._sendColor(id, hs);
    }
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

  _readLocal() {
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
      if (legacy) return { presets: legacy, updatedAt: 1 };
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /**
   * Read the shared/per-user remote store. Prefers the cross-user
   * hue_color_wheel integration; if that command isn't registered (component
   * not installed) it permanently falls back to per-user frontend storage.
   */
  async _readRemote() {
    if (this._storageMode !== "user") {
      try {
        const resp = await this._hass.callWS({
          type: "hue_color_wheel/get",
          key: this._storeKey(),
        });
        this._storageMode = "shared";
        this._ensureSubscribed();
        return resp ? resp.value : null;
      } catch (e) {
        if (e && e.code === "unknown_command") {
          this._storageMode = "user"; // integration not installed
        } else {
          return null; // transient error; keep mode, retry later
        }
      }
    }
    try {
      const resp = await this._hass.callWS({
        type: "frontend/get_user_data",
        key: this._storeKey(),
      });
      if (resp && resp.value) return resp.value;
    } catch (e) {
      // older HA or transient WS error; caller falls back to local
    }
    return null;
  }

  /** Subscribe to live push from the shared backend (real-time sync). */
  _ensureSubscribed() {
    if (
      this._subscribed ||
      this._storageMode !== "shared" ||
      !this._hass ||
      !this._hass.connection ||
      typeof this._hass.connection.subscribeMessage !== "function"
    ) {
      return;
    }
    this._subscribed = true;
    this._hass.connection
      .subscribeMessage((ev) => this._onRemotePush(ev), {
        type: "hue_color_wheel/subscribe",
        key: this._storeKey(),
      })
      .then((unsub) => {
        this._unsub = unsub;
      })
      .catch(() => {
        this._subscribed = false; // allow a later retry
      });
  }

  _onRemotePush(ev) {
    const value = ev && ev.value;
    if (!value || this._drag || this._expandedCluster) return;
    if ((value.updatedAt || 0) > this._storeUpdatedAt) {
      this._applyStore(value);
      this._writeLocal(value);
      if (this._built) this._updateAll();
    }
  }

  /**
   * Initial load on card build. Paint instantly from the local cache, then
   * reconcile with the server (the shared source of truth across devices).
   */
  async _restoreStore() {
    this._restoring = true;
    try {
      const local = this._readLocal();
      if (local) this._applyStore(local);
      const remote = await this._readRemote();
      if (remote && (remote.updatedAt || 0) >= (local?.updatedAt || 0)) {
        this._applyStore(remote);
        this._writeLocal(remote); // refresh cache with the authoritative copy
      } else if (local && !remote) {
        // server has nothing yet — seed it from this device
        this._storeUpdatedAt = local.updatedAt || 0;
        this._writeRemote(local);
      }
    } finally {
      this._restoring = false;
    }
    this._seedDeclarativeGroups(); // config groups, on top of restored state
    if (this._built) this._updateAll();
  }

  /** Create any YAML-configured groups that aren't already present. */
  _seedDeclarativeGroups() {
    if (this._seededGroups || !Array.isArray(this._config.groups)) return;
    this._seededGroups = true;
    let added = false;
    for (const g of this._config.groups) {
      const members = (g.entities || g.lights || []).filter((e) => this._pins.has(e));
      if (members.length < 2) continue;
      if (members.some((e) => this._clusterFor(e))) continue; // respect existing
      const hs0 = this._lastHs.get(members[0]);
      this._clusters.push({
        members: [...members],
        hs: Array.isArray(hs0) ? hs0.slice() : [0, 0],
        temp: this._lastTemp.get(members[0]) || DEFAULT_TEMP_K,
        no: ++this._groupSeq,
        name: g.name || null,
        whiteX: 0,
        settleUntil: 0,
      });
      added = true;
    }
    if (added) this._scheduleSave();
  }

  /** Dim the wheel canvas to roughly track the lights' brightness. */
  _updateWheelBrightness() {
    if (!this._canvas) return;
    const vals = [];
    for (const entity of this._pins.keys()) {
      const s = this._hass.states[entity];
      if (s?.state === "on" && s.attributes.brightness != null) {
        vals.push(s.attributes.brightness / 255);
      }
    }
    const frac = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
    // never fully black — keep the wheel readable even at minimum
    this._canvas.style.filter = `brightness(${(0.45 + 0.55 * frac).toFixed(3)})`;
  }

  /**
   * Re-fetch the shared state from the server and apply it if it is newer
   * than what we last applied. Called when the page/app returns to the
   * foreground and when the WebSocket reconnects.
   */
  async _syncFromServer() {
    // don't reshuffle state out from under an active drag or an open ring
    if (!this._hass || !this._built || this._drag || this._expandedCluster) return;
    const remote = await this._readRemote();
    if (!remote) return;
    if ((remote.updatedAt || 0) > this._storeUpdatedAt) {
      this._applyStore(remote);
      this._writeLocal(remote);
      if (this._built) this._updateAll();
    }
  }

  /** Apply a loaded store object to card state (does not persist). */
  _applyStore(data) {
    if (!data) return;
    this._storeUpdatedAt = Math.max(this._storeUpdatedAt, data.updatedAt || 0);
    if (data.presets && typeof data.presets === "object") {
      this._presets = data.presets;
      this._renderPresets();
    }
    if ((data.mode === "color" || data.mode === "white") && data.mode !== this._mode) {
      this._applyMode(data.mode);
    }
    // For lights that are ON, live hass state is authoritative for their
    // color/brightness; stored values only fill in lights that are off.
    if (data.lastHs) {
      for (const [entity, hs] of Object.entries(data.lastHs)) {
        if (!this._pins.has(entity) || !Array.isArray(hs)) continue;
        if (this._hass?.states[entity]?.state === "on") continue;
        this._lastHs.set(entity, hs.slice(0, 2));
      }
    }
    if (data.lastTemp) {
      for (const [entity, k] of Object.entries(data.lastTemp)) {
        if (!this._pins.has(entity)) continue;
        if (this._hass?.states[entity]?.state === "on") continue;
        this._lastTemp.set(entity, k);
      }
    }
    if (data.whiteX) {
      for (const [entity, x] of Object.entries(data.whiteX)) {
        if (this._pins.has(entity)) this._whiteX.set(entity, x);
      }
    }
    if (data.lastBrightness) {
      for (const [entity, pct] of Object.entries(data.lastBrightness)) {
        if (!this._pins.has(entity)) continue;
        if (this._hass?.states[entity]?.state === "on") continue;
        this._lastBrightness.set(entity, pct);
      }
    }
    if (typeof data.groupSeq === "number") {
      this._groupSeq = Math.max(this._groupSeq, data.groupSeq);
    }
    if (Array.isArray(data.clusters)) {
      this._clusters = data.clusters
        .map((c) => ({
          members: (c.members || []).filter((id) => this._pins.has(id)),
          hs: Array.isArray(c.hs) ? c.hs.slice(0, 2) : [0, 0],
          temp: c.temp || DEFAULT_TEMP_K,
          whiteX: typeof c.whiteX === "number" ? c.whiteX : 0,
          no: c.no || ++this._groupSeq,
          name: c.name || null,
          settleUntil: Date.now() + CLUSTER_SETTLE_MS,
        }))
        .filter((c) => c.members.length >= 2);
      this._selectedCluster = null;
      this._refreshClusterStyles?.();
    }
  }

  _buildStoreValue() {
    return {
      v: 1,
      updatedAt: Date.now(),
      mode: this._mode,
      groupSeq: this._groupSeq,
      clusters: this._clusters.map((c) => ({
        members: [...c.members],
        hs: c.hs,
        temp: c.temp,
        whiteX: c.whiteX,
        no: c.no,
        name: c.name,
      })),
      lastHs: Object.fromEntries(this._lastHs),
      lastTemp: Object.fromEntries(this._lastTemp),
      whiteX: Object.fromEntries(this._whiteX),
      lastBrightness: Object.fromEntries(this._lastBrightness),
      presets: this._presets,
    };
  }

  _writeLocal(value) {
    try {
      localStorage.setItem(this._localKey(), JSON.stringify(value));
    } catch (e) {
      /* storage full or unavailable */
    }
  }

  _writeRemote(value) {
    if (!this._hass) return;
    const shared = this._storageMode !== "user";
    const type = shared ? "hue_color_wheel/set" : "frontend/set_user_data";
    this._hass
      .callWS({ type, key: this._storeKey(), value })
      .catch((err) => {
        if (shared && err && err.code === "unknown_command") {
          // shared backend not installed: fall back to per-user storage
          this._storageMode = "user";
          this._writeRemote(value);
          return;
        }
        if (!this._warnedWrite) {
          this._warnedWrite = true;
          console.warn(
            "hue-color-wheel-card: could not save state to Home Assistant; " +
              "cross-device sync disabled, falling back to this browser only.",
            err
          );
        }
      });
  }

  /**
   * Persist on every change: write the local cache synchronously (survives a
   * refresh/app close at any instant) and debounce the per-user server sync
   * that carries state to other browsers/devices. Each save stamps updatedAt
   * so devices reconcile newest-wins.
   */
  _scheduleSave() {
    if (!this._lights || this._restoring) return;
    const value = (this._pendingSave = this._buildStoreValue());
    this._storeUpdatedAt = value.updatedAt;
    this._writeLocal(value);
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._syncRemote(), 1200);
  }

  _syncRemote() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const value = this._pendingSave;
    if (!value) return;
    this._pendingSave = null;
    this._writeRemote(value);
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
      this._brightPct.textContent = `${this._slider.value}%`;
      return;
    } else if (this._selectedCluster) {
      this._brightnessLabel.textContent = this._groupName(this._selectedCluster);
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
    this._brightPct.textContent = `${this._slider.value}%`;
  }

  /** Expanded set of entity IDs the brightness slider should target. */
  _brightnessTargets() {
    if (!this._multi.size) return new Set(); // means "all on lights"
    // expand through clusters so stacked members are included even if only
    // the representative pin is in _multi
    const result = new Set();
    for (const id of this._multi) {
      // white mode ignores clustering, so each selected pin targets itself
      const cluster = this._mode === "white" ? null : this._clusterFor(id);
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
    if (this._brightPct) this._brightPct.textContent = `${pct}%`;
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
