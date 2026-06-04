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

import logging

import httpx

_LOGGER = logging.getLogger(__name__)

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
        """Reject / hang up the call."""
        await self._request(
            "PUT",
            "/ISAPI/VideoIntercom/callSignal?format=json",
            json={"CallSignal": {"cmdType": "reject"}},
        )

    async def async_open_door(self) -> None:
        """Open the door relay."""
        await self._request(
            "PUT",
            f"/ISAPI/AccessControl/RemoteControl/door/{self._door_no}",
            content="<RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>",
            headers={"Content-Type": "application/xml"},
        )
