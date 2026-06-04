"""The BMS Intercom integration."""
from __future__ import annotations

import hashlib
import logging
import os

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_PROXY_PORT, DEFAULT_PROXY_PORT, DOMAIN, PLATFORMS
from .device import BMSIntercomDevice
from .proxy import HTTPSProxy

_LOGGER = logging.getLogger(__name__)

_PROXY_KEY = f"{DOMAIN}_https_proxy"
_FRONTEND_FLAG = f"{DOMAIN}_frontend_registered"
_STATIC_URL = f"/{DOMAIN}_static"
_CARD_FILE = "bms_intercom_card.js"


def _card_version() -> str:
    """Cache-busting tag derived from the card file itself.

    Using a content hash means the popup updates in browsers on every change
    without anyone having to bump a version by hand (and a full HA restart is
    enough to pick it up).
    """
    path = os.path.join(os.path.dirname(__file__), "frontend", _CARD_FILE)
    try:
        with open(path, "rb") as fh:
            return hashlib.md5(fh.read()).hexdigest()[:10]
    except OSError:
        return "dev"


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve and auto-load the bundled popup module (once per HA run)."""
    if hass.data.get(_FRONTEND_FLAG):
        return
    hass.data[_FRONTEND_FLAG] = True
    frontend_dir = os.path.join(os.path.dirname(__file__), "frontend")
    await hass.http.async_register_static_paths(
        [StaticPathConfig(_STATIC_URL, frontend_dir, False)]
    )
    version = await hass.async_add_executor_job(_card_version)
    card_url = f"{_STATIC_URL}/{_CARD_FILE}?v={version}"
    add_extra_js_url(hass, card_url)
    _LOGGER.debug("Поп-ап домофона зарегистрирован: %s", card_url)


async def _async_start_proxy(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Start the built-in local HTTPS endpoint once (for the microphone)."""
    if hass.data.get(_PROXY_KEY) is not None:
        return
    port = entry.options.get(CONF_PROXY_PORT, DEFAULT_PROXY_PORT)
    proxy = HTTPSProxy(hass, port)
    hass.data[_PROXY_KEY] = proxy
    await proxy.async_start()


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up BMS Intercom from a config entry."""
    await _async_register_frontend(hass)
    await _async_start_proxy(hass, entry)

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
        # Stop the shared HTTPS proxy when the last intercom is removed.
        if not hass.data.get(DOMAIN):
            proxy = hass.data.pop(_PROXY_KEY, None)
            if proxy is not None:
                await proxy.async_stop()
    return unload_ok


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry when its options change."""
    await hass.config_entries.async_reload(entry.entry_id)
