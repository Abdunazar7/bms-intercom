"""Buttons to drive the intercom: simulate call, answer, reject, open door."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
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
    entities: list[ButtonEntity] = [
        AnswerButton(device),
        RejectButton(device),
        OpenDoorButton(device),
    ]
    # The "simulate call" button only makes sense without real hardware.
    if device.is_demo:
        entities.append(SimulateCallButton(device))
    async_add_entities(entities)


class SimulateCallButton(BMSIntercomEntity, ButtonEntity):
    _attr_name = "Симулировать звонок"
    _attr_icon = "mdi:phone-plus"
    _intercom_role = "simulate"

    def __init__(self, device: BMSIntercomDevice) -> None:
        super().__init__(device, "simulate_call")

    async def async_press(self) -> None:
        await self.device.async_simulate_call()


class AnswerButton(BMSIntercomEntity, ButtonEntity):
    _attr_name = "Ответить"
    _attr_icon = "mdi:phone"
    _intercom_role = "answer"

    def __init__(self, device: BMSIntercomDevice) -> None:
        super().__init__(device, "answer")

    async def async_press(self) -> None:
        await self.device.async_answer()


class RejectButton(BMSIntercomEntity, ButtonEntity):
    _attr_name = "Сбросить"
    _attr_icon = "mdi:phone-hangup"
    _intercom_role = "reject"

    def __init__(self, device: BMSIntercomDevice) -> None:
        super().__init__(device, "reject")

    async def async_press(self) -> None:
        await self.device.async_reject()


class OpenDoorButton(BMSIntercomEntity, ButtonEntity):
    _attr_name = "Открыть дверь"
    _attr_icon = "mdi:door-open"
    _intercom_role = "open_door"

    def __init__(self, device: BMSIntercomDevice) -> None:
        super().__init__(device, "open_door")

    async def async_press(self) -> None:
        await self.device.async_open_door()
