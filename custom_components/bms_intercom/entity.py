"""Base entity shared by all BMS Intercom platforms."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, SIGNAL_STATE_UPDATED
from .device import BMSIntercomDevice


class BMSIntercomEntity(Entity):
    """Groups every entity under one 'Домофон' device and auto-refreshes it."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    # Lets the bundled popup card discover and group an intercom's entities.
    _intercom_role: str | None = None

    def __init__(self, device: BMSIntercomDevice, key: str) -> None:
        self.device = device
        self._attr_unique_id = f"{device.entry.entry_id}_{key}"

    @property
    def available(self) -> bool:
        return self.device.available

    @property
    def intercom_attributes(self) -> dict[str, str]:
        """Stable markers the popup card reads to wire entities together."""
        attrs = {
            "intercom_id": self.device.entry.entry_id,
            "intercom_name": self.device.name,
        }
        if self._intercom_role:
            attrs["intercom_role"] = self._intercom_role
        if self.device.https_url:
            attrs["intercom_https_base"] = self.device.https_url
        attrs["intercom_https_port"] = str(self.device.proxy_port)
        return attrs

    @property
    def extra_state_attributes(self) -> dict[str, str]:
        return self.intercom_attributes

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self.device.entry.entry_id)},
            name=self.device.name,
            manufacturer="BMS Smart Home",
            model="Вызывная панель",
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                SIGNAL_STATE_UPDATED.format(self.device.entry.entry_id),
                self.async_write_ha_state,
            )
        )
