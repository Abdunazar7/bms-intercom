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
    CONF_PROXY_PORT,
    CONF_RTSP_PORT,
    DEFAULT_PROXY_PORT,
    DEFAULT_DOOR_NO,
    DEFAULT_HTTP_PORT,
    DEFAULT_NAME,
    DEFAULT_RTSP_PORT,
    DOMAIN,
    MODE_DEMO,
    RTSP_STREAM_PATH,
    SIGNAL_STATE_UPDATED,
)
from .isapi import (
    STATUS_ANSWERED,
    STATUS_RINGING,
    ISAPIClient,
    ISAPIError,
    TwoWayAudioError,
    TwoWayAudioSession,
)

_LOGGER = logging.getLogger(__name__)

# Call states
STATE_IDLE = "idle"
STATE_RINGING = "ringing"
STATE_ANSWERED = "answered"

# After the operator answers we keep the conversation open locally for up to
# this long, regardless of the panel's callStatus. A villa door station drops
# its "call" quickly (it rings indoor units / Hik-Connect, not HA), but the
# two-way audio/video runs through go2rtc and is independent of that — so the
# popup must stay until the operator hangs up (or this safety timeout).
MAX_TALK_SECONDS = 180

# Once the panel starts ringing, keep the popup open for at least this long,
# even if the panel drops the call almost immediately (e.g. no internet → it
# can't reach Hik-Connect and gives up in a second). Gives the operator time
# to actually see and answer the call locally.
RING_WINDOW_SECONDS = 25

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
        self.view_active: bool = False         # открыт ли idle-просмотр (без вызова)
        self.available: bool = True
        self._client: ISAPIClient | None = None
        self._unsub_poll = None
        self._talk: TwoWayAudioSession | None = None  # активная отправка микрофона
        self._backchannel_ready = False        # ISAPI-источник уже в go2rtc
        self._backchannel_warned = False       # чтобы не спамить, если go2rtc нет
        self._backchannel_unsupported = False  # go2rtc без isapi-модуля
        self._go2rtc_probed = False            # версию go2rtc уже залогировали
        self._answered = False                 # оператор ответил (латч разговора)
        self._answered_at = 0.0                # время ответа (для тайм-аута)
        self._ringing_at = 0.0                 # время начала звонка (окно звонка)

    @property
    def is_demo(self) -> bool:
        return self.mode == MODE_DEMO

    @property
    def call_active(self) -> bool:
        return self.call_state in (STATE_RINGING, STATE_ANSWERED)

    @property
    def https_url(self) -> str | None:
        """Optional explicit HTTPS address override (secure context)."""
        return self.entry.options.get(CONF_HTTPS_URL) or None

    @property
    def proxy_port(self) -> int:
        """Port of the built-in auto HTTPS endpoint."""
        return self.entry.options.get(CONF_PROXY_PORT, DEFAULT_PROXY_PORT)

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

        # Авто-настройка панели: кодек two-way audio = G.711 (best-effort), чтобы
        # микрофон браузера доходил без перекодирования.
        try:
            await self._client.async_ensure_twoway_codec()
        except ISAPIError as err:
            _LOGGER.debug("[%s] Не удалось задать кодек two-way audio: %s", self.name, err)

    async def async_get_snapshot(self) -> bytes | None:
        """Real mode: fetch a still JPEG from the panel (None if unavailable)."""
        if self._client is None:
            return None
        try:
            return await self._client.async_get_snapshot()
        except ISAPIError as err:
            _LOGGER.debug("[%s] Снимок недоступен: %s", self.name, err)
            return None

    async def async_shutdown(self) -> None:
        """Stop the poller and close the ISAPI client."""
        await self.async_talk_stop()
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

        # Латч разговора: пока оператор «в разговоре», держим ANSWERED и не
        # даём опросу сбросить его в idle (панель-вилла быстро рапортует idle,
        # хотя звук/видео идут через go2rtc). Выход — «Сбросить» или тайм-аут.
        if self._answered:
            if self.hass.loop.time() - self._answered_at <= MAX_TALK_SECONDS:
                await self._async_ensure_backchannel()
                return
            _LOGGER.debug("[%s] Разговор завершён по тайм-ауту", self.name)
            self._answered = False

        new_state = _ISAPI_STATUS_TO_STATE.get(raw, STATE_IDLE)

        # Окно звонка: запоминаем момент начала звонка и держим окно открытым
        # ещё RING_WINDOW_SECONDS, даже если панель почти сразу бросает вызов
        # (нет интернета → не достучалась до Hik-Connect). Чтобы оператор успел
        # увидеть и ответить.
        if new_state == STATE_RINGING and self.call_state != STATE_RINGING:
            self._ringing_at = self.hass.loop.time()
        if (
            self.call_state == STATE_RINGING
            and new_state == STATE_IDLE
            and self.hass.loop.time() - self._ringing_at <= RING_WINDOW_SECONDS
        ):
            await self._async_ensure_backchannel()
            return  # держим RINGING ещё немного, чтобы можно было ответить

        if new_state != self.call_state:
            _LOGGER.debug("[%s] Статус вызова: %s -> %s", self.name, self.call_state, new_state)
            self.call_state = new_state
            self._notify()

        # NB: микрофон теперь идёт напрямую через native ISAPI two-way audio
        # (см. async_talk_*), поэтому обратный канал go2rtc больше не нужен и
        # не вызывается, чтобы не открывать вторую two-way-сессию к панели.

    async def _async_ensure_backchannel(self) -> None:
        """Append the Hikvision ISAPI two-way-audio source to the camera's
        go2rtc stream.

        Hikvision door stations don't do a reliable RTSP backchannel — go2rtc
        needs a separate `isapi://user:pass@host:port/` source. Home Assistant's
        go2rtc integration only registers the RTSP video source, so we add the
        ISAPI one ourselves via go2rtc's REST API. Idempotent: skips streams
        that already have it. Re-runs each poll so it survives go2rtc/HA
        re-registering the stream.
        """
        if self._backchannel_unsupported:
            return  # этот go2rtc не умеет isapi-источник — больше не пытаемся
        cfg = self.hass.data.get("go2rtc")
        if cfg is None:
            if not self._backchannel_warned:
                self._backchannel_warned = True
                _LOGGER.warning(
                    "[%s] go2rtc HA не найден (hass.data['go2rtc']). Двусторонний "
                    "звук требует встроенного go2rtc Home Assistant.", self.name,
                )
            return
        base = getattr(cfg, "url", None)
        session = getattr(cfg, "session", None)
        host = self.entry.data.get(CONF_HOST)
        if not base or session is None or not host:
            return

        # Один раз залогируем версию и адрес go2rtc (для диагностики).
        if not self._go2rtc_probed:
            self._go2rtc_probed = True
            try:
                async with session.get(f"{base}/api") as resp:
                    info = await resp.json()
                _LOGGER.debug(
                    "[%s] go2rtc: версия %s, url=%s", self.name, info.get("version"), base
                )
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("[%s] go2rtc /api недоступен (%s), url=%s", self.name, err, base)

        user = quote(self.entry.data.get(CONF_USERNAME, ""), safe="")
        pwd = quote(self.entry.data.get(CONF_PASSWORD, ""), safe="")
        http_port = self.entry.data.get(CONF_HTTP_PORT, DEFAULT_HTTP_PORT)
        isapi_src = f"isapi://{user}:{pwd}@{host}:{http_port}/"

        # Имя потока, под которым HA зарегистрировал нашу камеру в go2rtc
        # (обычно совпадает с entity_id камеры).
        from homeassistant.helpers import entity_registry as er

        cam_eid = er.async_get(self.hass).async_get_entity_id(
            "camera", DOMAIN, f"{self.entry.entry_id}_camera"
        )

        try:
            async with session.get(f"{base}/api/streams") as resp:
                streams = await resp.json()
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("[%s] go2rtc: список потоков недоступен: %s", self.name, err)
            return

        names = list((streams or {}).keys())
        # Какие потоки go2rtc принадлежат нашей камере: сперва точное имя
        # (entity_id), иначе все, где встречается хост панели.
        if cam_eid and cam_eid in (streams or {}):
            targets = [cam_eid]
        else:
            targets = [n for n, info in (streams or {}).items() if host in str(info)]

        if not targets:
            _LOGGER.debug(
                "[%s] go2rtc: поток камеры ещё не создан (ищу '%s'/host %s среди %s)",
                self.name, cam_eid, host, names,
            )
            return

        rtsp = self.rtsp_url
        for name in targets:
            if "isapi://" in str(streams.get(name)):
                if not self._backchannel_ready:
                    self._backchannel_ready = True
                    _LOGGER.debug("[%s] go2rtc: обратный канал ISAPI на месте ('%s')", self.name, name)
                continue
            # PUT задаёт ИМЕННО этот набор источников (заменяет). Поэтому шлём
            # rtsp ПЕРВЫМ и isapi вторым: видео сохраняется, добавляется
            # обратный звук. На старых go2rtc читается только первый src —
            # тогда останется только rtsp (видео цело, talk-back просто не
            # появится), сломать видео это не может.
            params = [("name", name), ("src", rtsp), ("src", isapi_src)]
            try:
                async with session.put(f"{base}/api/streams", params=params) as resp:
                    if resp.status < 300:
                        self._backchannel_ready = True
                        _LOGGER.info(
                            "[%s] go2rtc: добавлен обратный аудиоканал ISAPI к потоку '%s'",
                            self.name, name,
                        )
                    else:
                        body = await resp.text()
                        if resp.status == 400 and "not supported" in body.lower():
                            # В этом go2rtc нет isapi-модуля → двусторонний звук
                            # через go2rtc невозможен. Сообщаем один раз и больше
                            # не дёргаем API.
                            self._backchannel_unsupported = True
                            _LOGGER.warning(
                                "[%s] go2rtc не поддерживает источник isapi:// "
                                "(%s). Двусторонний звук через go2rtc недоступен "
                                "на этой сборке go2rtc. Видео и входящий звук "
                                "работают.", self.name, body.strip()[:120],
                            )
                            return
                        _LOGGER.warning(
                            "[%s] go2rtc: PUT '%s' вернул HTTP %s: %s",
                            self.name, name, resp.status, body[:200],
                        )
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("[%s] go2rtc: ошибка PUT: %s", self.name, err)

    # --- Two-way audio (microphone → panel via native ISAPI) ---------------
    async def async_talk_start(self) -> None:
        """Open the panel's two-way audio channel for the operator's mic."""
        if self.is_demo:
            return
        host = self.entry.data.get(CONF_HOST)
        if not host or self._talk is not None:
            return
        sess = TwoWayAudioSession(
            host,
            self.entry.data.get(CONF_HTTP_PORT, DEFAULT_HTTP_PORT),
            self.entry.data.get(CONF_USERNAME, ""),
            self.entry.data.get(CONF_PASSWORD, ""),
        )
        try:
            await sess.async_open()
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("[%s] Не удалось открыть микрофон к панели: %s", self.name, err)
            await sess.async_close()
            return
        self._talk = sess
        _LOGGER.debug("[%s] Микрофон к панели открыт (кодек %s)", self.name, sess.codec)

    async def async_talk_send(self, data: bytes) -> None:
        """Forward a chunk of G.711 mic audio to the panel."""
        if self._talk is None:
            return
        try:
            await self._talk.async_send(data)
        except TwoWayAudioError as err:
            _LOGGER.debug("[%s] Микрофон: поток оборвался (%s)", self.name, err)
            await self.async_talk_stop()

    async def async_talk_stop(self) -> None:
        """Close the panel's two-way audio channel."""
        sess, self._talk = self._talk, None
        if sess is not None:
            await sess.async_close()

    # --- Actions -----------------------------------------------------------
    async def async_set_view(self, on: bool) -> None:
        """Open/close the idle live-preview popup (no call involved)."""
        if self.view_active != on:
            self.view_active = on
            self._notify()

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
        # Включаем латч разговора: дальше опрос не сбросит окно в idle, пока
        # оператор не нажмёт «Сбросить» (или не истечёт MAX_TALK_SECONDS).
        self._answered = True
        self._answered_at = self.hass.loop.time()
        self.call_state = STATE_ANSWERED
        self._notify()

    async def async_reject(self) -> None:
        """Reject a ringing call or hang up an active conversation.

        The panel uses different commands for the two cases: an answered call
        is ended with `hangUp`, a still-ringing one with `reject`. We send the
        command that matches the current state and fall back to the other one
        if a given firmware disagrees, so the button always ends the call.
        """
        if self.is_demo:
            _LOGGER.info("[%s] Вызов сброшен (демо)", self.name)
        elif self._client is not None:
            answered = self.call_state == STATE_ANSWERED
            primary = self._client.async_hangup if answered else self._client.async_reject
            fallback = self._client.async_reject if answered else self._client.async_hangup
            try:
                await primary()
            except ISAPIError as err:
                _LOGGER.warning(
                    "[%s] Основная команда завершения не прошла (%s), пробую запасную",
                    self.name,
                    err,
                )
                try:
                    await fallback()
                except ISAPIError as err2:
                    _LOGGER.error("[%s] Не удалось завершить вызов: %s", self.name, err2)
                    return
        self._answered = False  # снимаем латч разговора
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
