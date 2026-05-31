"""The BMS Intercom integration."""
from __future__ import annotations

import logging
import os

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, PLATFORMS
from .device import BMSIntercomDevice

_LOGGER = logging.getLogger(__name__)

_FRONTEND_FLAG = f"{DOMAIN}_frontend_registered"
_STATIC_URL = f"/{DOMAIN}_static"
# Bump on any frontend change so browsers reload the cached module.
_CARD_VERSION = "0.2.0"
_CARD_URL = f"{_STATIC_URL}/bms_intercom_card.js?v={_CARD_VERSION}"


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve and auto-load the bundled popup module (once per HA run)."""
    if hass.data.get(_FRONTEND_FLAG):
        return
    hass.data[_FRONTEND_FLAG] = True
    frontend_dir = os.path.join(os.path.dirname(__file__), "frontend")
    await hass.http.async_register_static_paths(
        [StaticPathConfig(_STATIC_URL, frontend_dir, False)]
    )
    add_extra_js_url(hass, _CARD_URL)
    _LOGGER.debug("Поп-ап домофона зарегистрирован: %s", _CARD_URL)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up BMS Intercom from a config entry."""
    await _async_register_frontend(hass)

    device = BMSIntercomDevice(hass, entry)
    await device.async_setup()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = device

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        device: BMSIntercomDevice = hass.data[DOMAIN].pop(entry.entry_id)
        await device.async_shutdown()
    return unload_ok


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry when its options change."""
    await hass.config_entries.async_reload(entry.entry_id)
