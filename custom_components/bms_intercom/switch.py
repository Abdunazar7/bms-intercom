"""Switch that opens the live-preview (idle) popup for the intercom.

It is not a hardware switch — turning it on tells the bundled popup card to
show the door camera with Open/Sound controls without an active call; turning
it off (or the popup's close button) hides it again.
"""
from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .device import BMSIntercomDevice
from .entity import BMSIntercomEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    device: BMSIntercomDevice = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([ViewSwitch(device)])


class ViewSwitch(BMSIntercomEntity, SwitchEntity):
    """Toggle the idle live-preview popup."""

    _attr_name = "Просмотр"
    _attr_icon = "mdi:cctv"
    _intercom_role = "view"

    def __init__(self, device: BMSIntercomDevice) -> None:
        super().__init__(device, "view")

    @property
    def is_on(self) -> bool:
        return self.device.view_active

    async def async_turn_on(self, **kwargs) -> None:
        await self.device.async_set_view(True)

    async def async_turn_off(self, **kwargs) -> None:
        await self.device.async_set_view(False)
