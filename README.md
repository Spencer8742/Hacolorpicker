# Hue Color Wheel Card

A custom Home Assistant Lovelace card that replicates the Philips Hue app's
color wheel: one large HSV color wheel with a **draggable pin per light**.
Drag a pin to a new spot on the wheel and the light changes color in real
time. No build step, no dependencies — a single JS file.

## Features

- Full 360° hue wheel; saturation grows from white at the center to fully
  saturated at the rim.
- One labeled pin per configured light, positioned at its current
  `hs_color` and filled with its actual current color (`rgb_color`).
- Drag a pin (mouse or touch) to call `light.turn_on` with the new
  `hs_color`. Calls are throttled (~6/sec) so the WebSocket isn't flooded.
- Dragging a light that is off turns it on with the new color.
- Tap an **off** light's pin to turn it on; tap an **on** light's pin to
  select it and adjust its brightness with the slider below the wheel.
  With nothing selected, the slider adjusts all currently-on lights.
- Pins update live when colors change externally (automations, the Hue
  app, other dashboards) via the standard `hass` reactive pattern.
- Off lights appear semi-transparent/grayed at their last-known position;
  unavailable lights show an error indicator and can't be dragged.
- Lights without `hs`/`xy`/`rgb` support (e.g. color-temp-only) are
  excluded from the wheel and listed in a note below the card.
- Mobile friendly: ≥44 px touch targets, page scrolling is suppressed
  while dragging, and the wheel scales responsively.

## Installation

1. Copy `hue-color-wheel-card.js` to your Home Assistant `/config/www/`
   directory.
2. Add a dashboard resource (Settings → Dashboards → ⋮ → Resources, or YAML):

   ```yaml
   resources:
     - url: /local/hue-color-wheel-card.js
       type: module
   ```

3. Add the card to a dashboard.

## Configuration

### Explicit light list

```yaml
type: custom:hue-color-wheel-card
lights:
  - entity: light.play_gradient_lightstrip_1
    label: Lightstrip 1
  - entity: light.play_gradient_lightstrip_2
    label: Lightstrip 2
  - entity: light.office_lamp
    label: Office Lamp
# Optional settings:
wheel_size: 300          # wheel diameter in px (max; scales down responsively), default 300
show_brightness: true    # show the brightness slider, default true
show_labels: true        # show labels under pins, default true
pin_size: 36             # pin diameter in px, default 36
```

Entries in `lights` may also be plain entity IDs:

```yaml
lights:
  - light.office_lamp
  - light.kitchen_strip
```

### Auto-populated lights

```yaml
type: custom:hue-color-wheel-card
auto_entities:
  area: office             # area name or area_id
  # or
  domain: light            # defaults to "light"
  include_filter: "light.hue_*"   # glob on entity_id
```

`area`, `domain`, and `include_filter` can be combined; all given filters
must match.

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `lights` | list | — | Lights to show. Each item is an entity ID or `{entity, label}`. |
| `auto_entities` | map | — | Auto-populate by `area`, `domain`, and/or `include_filter`. |
| `wheel_size` | number | `300` | Wheel diameter in px (responsive max-width). |
| `show_brightness` | bool | `true` | Show the brightness slider. |
| `show_labels` | bool | `true` | Show pin labels. |
| `pin_size` | number | `36` | Pin diameter in px (touch target is at least 44 px regardless). |

Either `lights` or `auto_entities` is required.

## Interaction summary

| Gesture | Result |
| ------- | ------ |
| Drag a pin | Live color change for that light (`hs_color`), throttled during drag |
| Tap an on light's pin | Select it — the slider now controls just that light; tap again to deselect |
| Tap an off light's pin | Turn it on |
| Tap empty wheel area | Deselect (slider controls all on lights) |
| Move the slider | `light.turn_on` with `brightness_pct` for the selection |

## Notes & edge cases

- Works with `hs` and `xy` color-mode lights — Home Assistant exposes
  `hs_color` for both and converts on the way in.
- Light groups/zones behave as a single pin.
- Off lights have no `hs_color` attribute, so their pin sits at the last
  color seen this session (or the wheel center until first seen on).
