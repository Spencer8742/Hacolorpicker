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
- **Merge by drop (like the Hue app)**: drag a pin onto another pin — the
  target highlights while you hover, and dropping snaps them into a single
  stacked pin with a count badge. The stack drags as one unit and all its
  lights share one color. Tap the stack to split it back apart (the pins
  fan out with a smooth animation).
- **Multi-select & group drag**: tap several pins to select them, then drag
  any selected pin — the whole group moves together, keeping its relative
  arrangement on the wheel. The brightness slider applies to the selection.
- **Presets**: a "Save preset" button snapshots every light's current
  color, brightness, and on/off state. Saved presets appear as chips —
  tap one to activate it, tap its ✕ to delete it.
- **Animation**: activating a preset glides the pins smoothly to their new
  positions instead of snapping.
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
show_presets: true       # show the preset save button and chips, default true
pin_size: 36             # pin diameter in px, default 36
merge_ring_size: 3       # thickness of the white merge highlight ring in px, default 3
merge_distance: 36       # px between pin centers to trigger a merge, default = pin_size
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
| `show_presets` | bool | `true` | Show the preset save button and preset chips. |
| `pin_size` | number | `36` | Pin diameter in px (touch target is at least 44 px regardless). |
| `merge_ring_size` | number | `3` | Thickness in px of the white ring that highlights a pin while another pin is dragged over it to merge. |
| `merge_distance` | number | `pin_size` | Distance in px between pin centers at which a drag snaps into a merge. Larger values make pins easier to combine (and keep them merged until they drift further apart). |

Either `lights` or `auto_entities` is required.

## Interaction summary

| Gesture | Result |
| ------- | ------ |
| Drag a pin | Live color change for that light (`hs_color`), throttled during drag |
| Drop a pin onto another pin | Merge them into a stacked pin (badge shows the count); the stack moves as one |
| Tap a stacked pin | Split the stack — pins fan back out around the spot |
| Tap an on light's pin | Toggle it in/out of the selection (selected pins show a ring) |
| Tap several pins, then drag one | The whole selection moves together as a group |
| Tap an off light's pin | Turn it on |
| Tap empty wheel area | Clear the selection (slider controls all on lights again) |
| Move the slider | `light.turn_on` with `brightness_pct` for the selection (or all on lights) |
| "+ Save preset" | Snapshot all lights' color/brightness/on-off state under a name |
| Tap a preset chip | Apply the preset — pins animate smoothly to their saved positions |
| Tap ✕ on a chip | Delete that preset |

## Notes & edge cases

- Works with `hs` and `xy` color-mode lights — Home Assistant exposes
  `hs_color` for both and converts on the way in.
- Light groups/zones behave as a single pin.
- Off lights have no `hs_color` attribute, so their pin sits at the
  last-known color, which is persisted (see Persistence below) — or the
  wheel center if the light has never been seen on.
- Presets aren't HA scene entities, so they're not visible to automations.
  If you need automation-accessible scenes, save the same look as a native
  HA scene; presets here are meant for quick dashboard recall.
- During a group drag, the per-light call throttle widens with the group
  size so the total WebSocket call rate stays roughly constant.
- **Persistence**: merged stacks, presets, and each light's last-known
  color and brightness are saved to Home Assistant's per-user frontend
  storage, so they survive reloads and follow you across pages, browsers,
  and devices (per HA user). The browser's `localStorage` is kept in sync
  as a fallback for older HA versions, and presets saved by pre-0.4
  versions of the card are migrated automatically.
- A stack dissolves on its own if a member turns off or something
  external (automation, Hue app) moves a member's color visibly away
  from the stack. Tap a stack once to control its brightness as a group;
  tap it again to split it.
