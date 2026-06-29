# Hue Color Wheel Card

A custom Home Assistant Lovelace card that replicates the Philips Hue app's
color wheel: one large HSV color wheel with a **draggable pin per light**.
Drag a pin to a new spot on the wheel and the light changes color in real
time. No build step, no dependencies — a single JS file.

## Features

- Full 360° hue wheel; saturation grows from white at the center to fully
  saturated at the rim.
- **Color / white toggle**: a small pill below the wheel switches between the
  color wheel and a **white color-temperature** wheel (warm amber at the top,
  cool blue-white at the bottom). In white mode, dragging a pin up/down sets
  the light's `color_temp` instead of `hs_color`. Color-temp-only lights
  (which can't show on the color wheel) become draggable in white mode.
- **Effects**: when any light advertises effects, a pill appears that opens an
  effects chooser (applies `light.turn_on` with `effect`).
- **Animation engine**: a play-button pill opens an animations panel with
  **Color cycle**, **Breathe**, **Candle**, **Sunrise**, and **Palette**
  (cycles through colors you pick). The card drives the animation itself with
  sparse keyframes + the light `transition` param, so it stays smooth without
  flooding the WebSocket. Animations target the current selection (or all on
  lights), have a slow/medium/fast speed, and stop the moment you take manual
  control. The palette and speed are saved/synced; seed colors with
  `animation_palette`. Note: the animation runs while the card is open (it's
  frontend-driven), so closing the dashboard stops it.
- **Teardrop pins with icons** tinted to each light's color; labels are
  auto-decluttered (only the selected, dragged, or grouped pins show a name).
- **Quick-color swatches** + a randomize button below the wheel; tap a swatch
  to apply it to the selection (or all on lights).
- **Tap-to-place**: with pins selected, tap anywhere on the wheel to send them
  to that color/temperature without dragging.
- **Long-press a pin or stack** for a popover: power on/off, a per-light (or
  per-group) brightness slider, **rename a group**, ungroup, or open Home
  Assistant's native more-info dialog.
- **Live readout** of the value while dragging, the wheel dims to track the
  lights' brightness, gentle haptics on merge/long-press, and the brightness
  slider shows a percentage.
- **Predefined groups** via the `groups:` config option, always present and
  named, on top of the runtime merge-by-drop grouping.
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
  stacked pin labeled **Group N** with a count badge. The stack drags as one
  unit and all its lights share one color/temperature. **Tap the stack to
  open it into a ring** (a Hue-style "well" with the member pins around the
  rim, each showing its own name); **drag a pin out of the ring to remove
  just that light** from the group, while the rest stay grouped. Tap the
  empty wheel to close the ring.
- **Groups are sticky** — once grouped, lights stay grouped through on/off
  changes, external recoloring, scenes, and switching between color and
  white modes. Membership only changes when you explicitly merge two pins or
  drag one out of an open ring, so you never have to rebuild a group.
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

### Optional: cross-user sync (shared stacks & presets)

By default the card's metadata (merged stacks, presets, off-light positions)
is stored **per Home Assistant user** — it syncs across all of that user's
own devices and browsers, but not between different HA login accounts.

To share that state across *all* users (e.g. you and a partner see the same
stacks), install the bundled backend integration. It adds a small shared,
server-side store and gives **real-time** updates — a change by one user
appears instantly for everyone.

1. Copy the `custom_components/hue_color_wheel/` folder into your Home
   Assistant `<config>/custom_components/` directory (so you have
   `<config>/custom_components/hue_color_wheel/__init__.py`).
2. Add this line to `configuration.yaml`:

   ```yaml
   hue_color_wheel:
   ```

3. Restart Home Assistant.

The card **auto-detects** the integration — no card config change needed. If
it isn't installed, the card silently uses per-user storage instead. Any
authenticated user can read and write the shared state (that shared
visibility is the point); the data persists across restarts.

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
title: Patio             # card header text; omit to auto-use the area name, or set false to hide
icon: mdi:lightbulb-group  # header icon, default mdi:lightbulb-group
wheel_size: 300          # wheel diameter in px (max; scales down responsively), default 300
show_brightness: true    # show the brightness slider, default true
show_labels: true        # show labels (auto-decluttered: only selected/group/dragged pins), default true
show_presets: true       # show the preset save button and chips, default true
show_white_toggle: true  # show the color/white (temperature) mode toggle, default true
show_swatches: true      # show the quick-color swatch row + randomize button, default true
show_effects: true       # show the effects toggle when lights support effects, default true
enable_haptics: true     # vibrate on merge / long-press on supported devices, default true
swatches:                # optional custom quick-colors as [hue, saturation] pairs
  - [0, 100]
  - [40, 100]
  - [210, 90]
pin_size: 36             # pin diameter in px, default 36
merge_ring_size: 3       # thickness of the white merge highlight ring in px, default 3
merge_distance: 36       # px between pin centers to trigger a merge, default = pin_size

# Optional predefined groups (always present, named):
groups:
  - name: Patio Cans
    entities:
      - light.patio_can_1
      - light.patio_can_2
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
| `show_white_toggle` | bool | `true` | Show the color/white color-temperature mode toggle below the wheel. |
| `pin_size` | number | `36` | Pin diameter in px (touch target is at least 44 px regardless). |
| `merge_ring_size` | number | `3` | Thickness in px of the white ring that highlights a pin while another pin is dragged over it to merge. |
| `merge_distance` | number | `pin_size` | Distance in px between pin centers at which a drag snaps into a merge. Larger values make pins easier to combine (and keep them merged until they drift further apart). |

Either `lights` or `auto_entities` is required.

## Interaction summary

| Gesture | Result |
| ------- | ------ |
| Drag a pin | Live color change for that light (`hs_color`), throttled during drag |
| Drop a pin onto another pin | Merge them into a stacked pin (badge shows the count); the stack moves as one |
| Tap a stacked pin | Open it into a ring (well) with the members around the rim |
| Drag a pin out of the ring | Remove just that light from the group at the dropped color |
| Drag a pin back into the ring | Keep it in the group |
| Tap the empty wheel | Close the ring |
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
- **Persistence & cross-device sync**: the actual light colors, brightness,
  and on/off states are stored and synced by Home Assistant itself — every
  device reads the same live `hass.states`, so those are always consistent.
  The card's own metadata (merged stacks, presets, and last-known positions
  for *off* lights) is saved to Home Assistant's per-user frontend storage
  (`frontend/set_user_data`) — the same server-side, per-user store the HA
  frontend uses for things like sidebar order. This is the shared source of
  truth across all your devices (logged in as the same HA user).
  - Every change writes a local cache immediately (so it survives a refresh
    or app close at any instant) and pushes to the server, stamped with a
    timestamp.
  - The card re-pulls the latest server state when the page/app returns to
    the foreground and whenever the WebSocket reconnects, so a change made
    on one device shows up on the others. Conflicts resolve newest-wins.
  - If the server write ever fails (e.g. a much older HA version without the
    user-data API), the card logs a one-time console warning and keeps
    working from the local cache (that device just won't sync).
  - Presets saved by pre-0.4 versions of the card are migrated automatically.
  - **Cross-user**: install the optional `hue_color_wheel` backend
    integration (see Installation) to share this metadata across *all* HA
    users with real-time push, instead of per-user. The card auto-detects it
    and migrates this device's existing state into the shared store on first
    load.
- A stack dissolves on its own if a member turns off or something
  external (automation, Hue app) moves a member's color visibly away
  from the stack. Tap a stack to open its ring — the whole group is
  selected for the brightness slider while open — and drag individual pins
  out of the ring to remove them.
- Groups work in **both** color and white modes and persist across the
  toggle: a group shares one color in color mode and one temperature in
  white mode. The white-mode wheel is a vertical warm→cool gradient, so a
  pin's vertical position is its temperature (horizontal is just spacing).
