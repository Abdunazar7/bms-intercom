"""Minimal ISAPI client for the DS-KV door station.

Covers exactly what the intercom needs:
  * read the current call status (poll)
  * answer / reject a call
  * open the door relay

Uses HTTP digest auth (the panel's default). All endpoints follow the panel's
public ISAPI spec for video-intercom devices; verify against your firmware if a
call differs (debug logging prints the exact request/response).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re

import httpx

_LOGGER = logging.getLogger(__name__)


# --- small helpers for native ISAPI two-way audio ----------------------------
def _between(s: str, a: str, b: str) -> str | None:
    """Return the substring between the first `a` and the next `b`."""
    i = s.find(a)
    if i < 0:
        return None
    i += len(a)
    j = s.find(b, i)
    return s[i:j] if j >= 0 else None


def _parse_digest_challenge(header: str) -> dict[str, str]:
    """Parse a `WWW-Authenticate: Digest ...` header into a dict."""
    params: dict[str, str] = {}
    h = header.split(" ", 1)[1] if " " in header else header
    for m in re.finditer(r'(\w+)=(?:"([^"]*)"|([^,]+))', h):
        params[m.group(1).lower()] = m.group(2) if m.group(2) is not None else (m.group(3) or "").strip()
    return params


def _digest_header(method: str, uri: str, chal: dict[str, str], user: str, pwd: str) -> str:
    """Build an `Authorization: Digest ...` header for the given challenge."""
    realm = chal.get("realm", "")
    nonce = chal.get("nonce", "")
    qop = chal.get("qop")
    opaque = chal.get("opaque")
    ha1 = hashlib.md5(f"{user}:{realm}:{pwd}".encode()).hexdigest()
    ha2 = hashlib.md5(f"{method}:{uri}".encode()).hexdigest()
    if qop:
        nc = "00000001"
        cnonce = os.urandom(8).hex()
        resp = hashlib.md5(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}".encode()).hexdigest()
        out = (
            f'Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{uri}", '
            f'qop=auth, nc={nc}, cnonce="{cnonce}", response="{resp}"'
        )
    else:
        resp = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()
        out = f'Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{uri}", response="{resp}"'
    if opaque:
        out += f', opaque="{opaque}"'
    return out


async def _read_http_head(reader: asyncio.StreamReader) -> tuple[int, dict[str, str]]:
    """Read an HTTP response up to the headers; return (status, headers)."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = await reader.read(1024)
        if not chunk:
            break
        data += chunk
        if len(data) > 65536:
            break
    head = data.split(b"\r\n\r\n", 1)[0].decode("iso-8859-1")
    lines = head.split("\r\n")
    parts = lines[0].split(" ") if lines else []
    status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return status, headers


class TwoWayAudioError(Exception):
    """Raised when ISAPI two-way audio fails."""


class TwoWayAudioSession:
    """Streams raw G.711 audio to a Hikvision panel via ISAPI two-way audio.

    Mirrors go2rtc's isapi client: discover the channel, (re)open the channel,
    then keep a raw socket to `.../audioData` open and write G.711 bytes to it.
    The audioData request is sent with Content-Length: 0 and the audio is then
    streamed over the same connection (Hikvision's non-standard scheme).
    """

    def __init__(self, host: str, http_port: int, username: str, password: str) -> None:
        self._host = host
        self._port = http_port
        self._user = username
        self._pass = password
        self._channel = "1"
        self.codec = "G.711ulaw"
        self._writer: asyncio.StreamWriter | None = None
        self._lock = asyncio.Lock()
        self._client = httpx.AsyncClient(timeout=10.0, verify=False)

    async def _req(self, method: str, path: str):
        auth = httpx.DigestAuth(self._user, self._pass)
        return await self._client.request(
            method, f"http://{self._host}:{self._port}{path}", auth=auth
        )

    async def async_open(self) -> None:
        """Discover the channel, (re)open it and open the audioData socket."""
        resp = await self._req("GET", "/ISAPI/System/TwoWayAudio/channels")
        xml = resp.text
        self._channel = _between(xml, "<id>", "<") or "1"
        self.codec = _between(xml, "<audioCompressionType>", "<") or "G.711ulaw"

        base = f"/ISAPI/System/TwoWayAudio/channels/{self._channel}"
        # A stale session blocks a new open; closing first is safe even if idle.
        try:
            await self._req("PUT", base + "/close")
        except httpx.HTTPError:
            pass
        await self._req("PUT", base + "/open")

        self._writer = await self._open_audio_socket(base + "/audioData")
        _LOGGER.debug("ISAPI two-way audio open: канал %s, кодек %s", self._channel, self.codec)

    async def _open_audio_socket(self, path: str) -> asyncio.StreamWriter:
        host, port = self._host, self._port
        body_head = (
            "Content-Type: application/octet-stream\r\n"
            "Content-Length: 0\r\n\r\n"
        )

        def request(auth: str | None) -> bytes:
            h = f"PUT {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
            if auth:
                h += f"Authorization: {auth}\r\n"
            return (h + body_head).encode()

        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), 10)
        writer.write(request(None))
        await writer.drain()
        status, headers = await asyncio.wait_for(_read_http_head(reader), 10)

        if status == 401:
            chal = _parse_digest_challenge(headers.get("www-authenticate", ""))
            auth = _digest_header("PUT", path, chal, self._user, self._pass)
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass
            reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), 10)
            writer.write(request(auth))
            await writer.drain()
            status, headers = await asyncio.wait_for(_read_http_head(reader), 10)

        if status != 200:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass
            raise TwoWayAudioError(f"audioData HTTP {status}")
        return writer

    async def async_send(self, data: bytes) -> None:
        """Write a chunk of raw G.711 audio to the panel."""
        if self._writer is None:
            return
        async with self._lock:
            try:
                self._writer.write(data)
                await asyncio.wait_for(self._writer.drain(), 5)
            except Exception as err:  # noqa: BLE001
                raise TwoWayAudioError(str(err)) from err

    async def async_close(self) -> None:
        """Stop streaming and close the two-way audio channel."""
        if self._writer is not None:
            try:
                self._writer.close()
            except Exception:  # noqa: BLE001
                pass
            self._writer = None
        try:
            await self._req("PUT", f"/ISAPI/System/TwoWayAudio/channels/{self._channel}/close")
        except httpx.HTTPError:
            pass
        await self._client.aclose()

# Call status reported by the panel -> our internal call states.
STATUS_IDLE = "idle"
STATUS_RINGING = "ringing"
STATUS_ANSWERED = "answered"

# Map the panel's raw status strings (lowercased) to the above.
_RAW_STATUS_MAP = {
    "idle": STATUS_IDLE,
    "hangup": STATUS_IDLE,
    "ended": STATUS_IDLE,
    "ring": STATUS_RINGING,
    "ringing": STATUS_RINGING,
    "calling": STATUS_RINGING,
    "oncall": STATUS_ANSWERED,
    "talking": STATUS_ANSWERED,
    "answered": STATUS_ANSWERED,
}


class ISAPIError(Exception):
    """Raised when an ISAPI request fails."""


class ISAPIClient:
    """Thin async wrapper around the panel's ISAPI endpoints."""

    def __init__(
        self,
        host: str,
        username: str,
        password: str,
        *,
        http_port: int = 80,
        door_no: int = 1,
        timeout: float = 10.0,
    ) -> None:
        self._base = f"http://{host}:{http_port}"
        self._door_no = door_no
        self._timeout = timeout
        # Store credentials so we can build a fresh DigestAuth per request.
        # Some Hikvision firmwares mishandle digest when the connection /
        # auth object is reused across requests, which leads to spurious 401s.
        self._username = username
        self._password = password
        # verify=False avoids loading certifi's CA bundle (a blocking file
        # read) inside the event loop — we only ever talk plain HTTP to the
        # panel, so TLS verification is irrelevant here anyway.
        self._client = httpx.AsyncClient(timeout=timeout, verify=False)

    async def async_close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        url = f"{self._base}{path}"
        # Build a fresh digest auth for every request.
        auth = httpx.DigestAuth(self._username, self._password)
        try:
            resp = await self._client.request(method, url, auth=auth, **kwargs)
            _LOGGER.debug(
                "ISAPI %s %s -> %s | body: %s",
                method,
                path,
                resp.status_code,
                resp.text[:200],
            )
            resp.raise_for_status()
            return resp
        except httpx.HTTPError as err:
            _LOGGER.debug("ISAPI %s %s FAILED: %s", method, path, err)
            raise ISAPIError(f"{method} {path}: {err}") from err

    async def async_verify(self) -> None:
        """Quick reachability/credentials check used by the config flow."""
        await self._request("GET", "/ISAPI/System/deviceInfo")

    async def async_get_snapshot(self, channel: int = 101) -> bytes:
        """Return a single JPEG snapshot from the panel's camera channel.

        Used for the dashboard thumbnail / still image; the live view goes
        through RTSP + go2rtc, but a poster frame needs a plain picture.
        """
        resp = await self._request(
            "GET", f"/ISAPI/Streaming/channels/{channel}/picture"
        )
        return resp.content

    async def async_get_call_status(self) -> str:
        """Return one of STATUS_IDLE / STATUS_RINGING / STATUS_ANSWERED."""
        resp = await self._request("GET", "/ISAPI/VideoIntercom/callStatus?format=json")
        try:
            raw = resp.json().get("CallStatus", {}).get("status", "idle")
        except ValueError:
            raw = "idle"
        return _RAW_STATUS_MAP.get(str(raw).lower(), STATUS_IDLE)

    async def async_answer(self) -> None:
        """Pick up the handset."""
        await self._request(
            "PUT",
            "/ISAPI/VideoIntercom/callSignal?format=json",
            json={"CallSignal": {"cmdType": "answer"}},
        )

    async def async_reject(self) -> None:
        """Reject an incoming (not yet answered) call."""
        await self._request(
            "PUT",
            "/ISAPI/VideoIntercom/callSignal?format=json",
            json={"CallSignal": {"cmdType": "reject"}},
        )

    async def async_hangup(self) -> None:
        """Hang up an active (already answered) call.

        Hikvision treats a ringing call and an in-progress conversation
        differently: `reject` only declines a call that is still ringing,
        while `hangUp` is what ends a call you have already answered.
        """
        await self._request(
            "PUT",
            "/ISAPI/VideoIntercom/callSignal?format=json",
            json={"CallSignal": {"cmdType": "hangUp"}},
        )

    async def async_open_door(self) -> None:
        """Open the door relay."""
        await self._request(
            "PUT",
            f"/ISAPI/AccessControl/RemoteControl/door/{self._door_no}",
            content="<RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>",
            headers={"Content-Type": "application/xml"},
        )

    async def async_ensure_twoway_codec(self, codec: str = "G.711ulaw") -> None:
        """Best-effort: set the panel's two-way audio codec to G.711.

        The browser sends G.711 µ-law; matching the panel avoids any need for
        transcoding. Silently does nothing if already set or unsupported.
        """
        resp = await self._request("GET", "/ISAPI/System/TwoWayAudio/channels")
        xml = resp.text
        cid = _between(xml, "<id>", "<") or "1"
        if _between(xml, "<audioCompressionType>", "<") == codec:
            return  # already correct
        chresp = await self._request("GET", f"/ISAPI/System/TwoWayAudio/channels/{cid}")
        chxml = chresp.text
        if "<audioCompressionType>" not in chxml:
            return
        new_xml = re.sub(
            r"<audioCompressionType>.*?</audioCompressionType>",
            f"<audioCompressionType>{codec}</audioCompressionType>",
            chxml,
            count=1,
        )
        await self._request(
            "PUT",
            f"/ISAPI/System/TwoWayAudio/channels/{cid}",
            content=new_xml,
            headers={"Content-Type": "application/xml"},
        )
        _LOGGER.info("ISAPI: кодек two-way audio установлен в %s (канал %s)", codec, cid)
