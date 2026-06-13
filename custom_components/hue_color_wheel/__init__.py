"""Shared storage backend for the Hue Color Wheel Lovelace card.

The Lovelace card itself is frontend-only and can normally persist its state
(merged stacks, presets, off-light pin positions) only per Home Assistant
user via ``frontend/set_user_data``. This integration adds a small shared,
server-side key/value store exposed over the WebSocket API so the card can
sync that state across *all* users — not just across one user's devices.

It registers three WebSocket commands:

* ``hue_color_wheel/get``       — read the shared value for a key
* ``hue_color_wheel/set``       — write the shared value for a key
* ``hue_color_wheel/subscribe`` — receive a push event whenever any client
  writes that key (real-time cross-user / cross-device sync)

Any authenticated user may read and write; that shared visibility is the
whole point. Data is persisted with Home Assistant's ``Store`` helper, so it
survives restarts.

Enable it by copying this folder to ``<config>/custom_components/`` and adding
``hue_color_wheel:`` to ``configuration.yaml`` (then restart HA).
"""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import (
    async_dispatcher_connect,
    async_dispatcher_send,
)
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType

DOMAIN = "hue_color_wheel"
STORAGE_KEY = "hue_color_wheel_card"
STORAGE_VERSION = 1
SIGNAL_UPDATED = f"{DOMAIN}_updated"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the shared store and register the WebSocket commands."""
    store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    data: dict = await store.async_load() or {}
    hass.data[DOMAIN] = {"store": store, "data": data}

    websocket_api.async_register_command(hass, ws_get)
    websocket_api.async_register_command(hass, ws_set)
    websocket_api.async_register_command(hass, ws_subscribe)
    return True


@websocket_api.websocket_command(
    {
        vol.Required("type"): "hue_color_wheel/get",
        vol.Required("key"): str,
    }
)
@callback
def ws_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Return the shared value stored under ``key`` (or null)."""
    data: dict = hass.data[DOMAIN]["data"]
    connection.send_result(msg["id"], {"value": data.get(msg["key"])})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "hue_color_wheel/set",
        vol.Required("key"): str,
        vol.Required("value"): dict,
    }
)
@websocket_api.async_response
async def ws_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Persist ``value`` under ``key`` and notify other subscribers."""
    store: Store = hass.data[DOMAIN]["store"]
    data: dict = hass.data[DOMAIN]["data"]
    key: str = msg["key"]
    value: dict = msg["value"]

    data[key] = value
    await store.async_save(data)

    # Push to every other subscribed client (the writer is skipped so it does
    # not echo its own change back to itself).
    async_dispatcher_send(hass, SIGNAL_UPDATED, key, value, connection)
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "hue_color_wheel/subscribe",
        vol.Required("key"): str,
    }
)
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Stream push events whenever ``key`` is written by any client."""
    key: str = msg["key"]

    @callback
    def _forward(changed_key: str, value: dict, origin: websocket_api.ActiveConnection) -> None:
        if changed_key != key or origin is connection:
            return
        connection.send_message(websocket_api.event_message(msg["id"], {"value": value}))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(
        hass, SIGNAL_UPDATED, _forward
    )
    connection.send_result(msg["id"])
