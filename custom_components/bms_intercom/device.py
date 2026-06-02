"""Device controller for a single BMS Intercom panel (real or demo)."""
from __future__ import annotations

import logging
from datetime import timedelta
from urllib.parse import quote

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_NAME, CONF_PASSWORD, CONF_USERNAME
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_interval

from .const import (
    CALL_POLL_INTERVAL,
    CONF_DOOR_NO,
    CONF_HTTP_PORT,
    CONF_HTTPS_URL,
    CONF_MODE,
    CONF_RTSP_PORT,
    DEFAULT_DOOR_NO,
    DEFAULT_HTTP_PORT,
    DEFAULT_NAME,
    DEFAULT_RTSP_PORT,
    MODE_DEMO,
    RTSP_STREAM_PATH,
    SIGNAL_STATE_UPDATED,
)
from .isapi import (
    STATUS_ANSWERED,
    STATUS_RINGING,
    ISAPIClient,
    ISAPIError,
)

_LOGGER = logging.getLogger(__name__)

# Call states
STATE_IDLE = "idle"
STATE_RINGING = "ringing"
STATE_ANSWERED = "answered"

# Panel call-status string -> internal call state.
_ISAPI_STATUS_TO_STATE = {
    STATUS_RINGING: STATE_RINGING,
    STATUS_ANSWERED: STATE_ANSWERED,
}


class BMSIntercomDevice:
    """Holds the call state and exposes the actions the UI can trigger.

    In demo mode the actions only update local state so the whole flow can be
    tested without hardware. In real mode they talk to the panel over ISAPI and
    a poller keeps the call state in sync with the panel.
    """

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.name: str = entry.data.get(CONF_NAME, DEFAULT_NAME)
        self.mode: str = entry.data.get(CONF_MODE, MODE_DEMO)
        self.call_state: str = STATE_IDLE
        self.available: bool = True
        self._client: ISAPIClient | None = None
        self._unsub_poll = None

    @property
    def is_demo(self) -> bool:
        return self.mode == MODE_DEMO

    @property
    def call_active(self) -> bool:
        return self.call_state in (STATE_RINGING, STATE_ANSWERED)

    @property
    def https_url(self) -> str | None:
        """HTTPS address of HA for the popup's microphone (secure context)."""
        return self.entry.options.get(CONF_HTTPS_URL) or None

    @property
    def rtsp_url(self) -> str | None:
        """RTSP main-stream URL of the panel (real mode only)."""
        host = self.entry.data.get(CONF_HOST)
        if not host:
            return None
        user = quote(self.entry.data.get(CONF_USERNAME, ""), safe="")
        pwd = quote(self.entry.data.get(CONF_PASSWORD, ""), safe="")
        port = self.entry.data.get(CONF_RTSP_PORT, DEFAULT_RTSP_PORT)
        return f"rtsp://{user}:{pwd}@{host}:{port}{RTSP_STREAM_PATH}"

    async def async_setup(self) -> None:
        """Prepare the device; in real mode start the ISAPI status poller."""
        _LOGGER.debug("Настройка домофона '%s' в режиме %s", self.name, self.mode)
        if self.is_demo:
            return

        self._client = ISAPIClient(
            self.entry.data[CONF_HOST],
            self.entry.data.get(CONF_USERNAME, ""),
            self.entry.data.get(CONF_PASSWORD, ""),
            http_port=self.entry.data.get(CONF_HTTP_PORT, DEFAULT_HTTP_PORT),
            door_no=self.entry.data.get(CONF_DOOR_NO, DEFAULT_DOOR_NO),
        )
        self._unsub_poll = async_track_time_interval(
            self.hass, self._async_poll, timedelta(seconds=CALL_POLL_INTERVAL)
        )

    async def async_shutdown(self) -> None:
        """Stop the poller and close the ISAPI client."""
        if self._unsub_poll is not None:
            self._unsub_poll()
            self._unsub_poll = None
        if self._client is not None:
            await self._client.async_close()
            self._client = None

    @callback
    def _notify(self) -> None:
        """Tell all entities of this device to refresh their state."""
        async_dispatcher_send(
            self.hass, SIGNAL_STATE_UPDATED.format(self.entry.entry_id)
        )

    async def _async_poll(self, _now) -> None:
        """Real mode: read the panel's call status and reflect it locally."""
        if self._client is None:
            return
        try:
            raw = await self._client.async_get_call_status()
        except ISAPIError as err:
            if self.available:
                _LOGGER.warning("[%s] Панель недоступна: %s", self.name, err)
            self.available = False
            self._notify()
            return

        if not self.available:
            _LOGGER.info("[%s] Связь с панелью восстановлена", self.name)
            self.available = True
            self._notify()

        new_state = _ISAPI_STATUS_TO_STATE.get(raw, STATE_IDLE)
        if new_state != self.call_state:
            _LOGGER.debug("[%s] Статус вызова: %s -> %s", self.name, self.call_state, new_state)
            self.call_state = new_state
            self._notify()

    # --- Actions -----------------------------------------------------------
    async def async_simulate_call(self) -> None:
        """Demo only: pretend the panel started ringing."""
        _LOGGER.info("[%s] Симуляция входящего вызова", self.name)
        self.call_state = STATE_RINGING
        self._notify()

    async def async_answer(self) -> None:
        """Answer the call (pick up the handset)."""
        if self.is_demo:
            _LOGGER.info("[%s] Вызов принят (демо)", self.name)
        elif self._client is not None:
            try:
                await self._client.async_answer()
            except ISAPIError as err:
                _LOGGER.error("[%s] Не удалось ответить: %s", self.name, err)
                return
        self.call_state = STATE_ANSWERED
        self._notify()

    async def async_reject(self) -> None:
        """Reject / hang up the call."""
        if self.is_demo:
            _LOGGER.info("[%s] Вызов сброшен (демо)", self.name)
        elif self._client is not None:
            try:
                await self._client.async_reject()
            except ISAPIError as err:
                _LOGGER.error("[%s] Не удалось сбросить: %s", self.name, err)
                return
        self.call_state = STATE_IDLE
        self._notify()

    async def async_open_door(self) -> None:
        """Open the door relay."""
        if self.is_demo:
            _LOGGER.info("[%s] Дверь открыта (демо)", self.name)
        elif self._client is not None:
            try:
                await self._client.async_open_door()
                _LOGGER.info("[%s] Команда открытия двери отправлена", self.name)
            except ISAPIError as err:
                _LOGGER.error("[%s] Не удалось открыть дверь: %s", self.name, err)
