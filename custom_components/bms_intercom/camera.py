"""Camera entity for the intercom.

Demo mode renders a self-contained animated MJPEG stream (no hardware, no
external services). Real mode returns the panel's RTSP URL, which Home
Assistant pipes through its bundled go2rtc for low-latency WebRTC with
two-way audio.
"""
from __future__ import annotations

import io
import math
import time

from homeassistant.components.camera import (
    Camera,
    CameraEntityFeature,
    async_get_still_stream,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .device import STATE_ANSWERED, STATE_RINGING, BMSIntercomDevice
from .entity import BMSIntercomEntity

_FRAME_W, _FRAME_H = 640, 480
_DEMO_FPS_INTERVAL = 0.2  # 5 fps is plenty for a placeholder stream


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    device: BMSIntercomDevice = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([IntercomCamera(device)])


class IntercomCamera(BMSIntercomEntity, Camera):
    """Live view of the door panel."""

    _attr_name = "Видео"
    _intercom_role = "camera"

    def __init__(self, device: BMSIntercomDevice) -> None:
        BMSIntercomEntity.__init__(self, device, "camera")
        Camera.__init__(self)
        if not device.is_demo:
            # Real panel: HA + go2rtc provide the live stream.
            self._attr_supported_features = CameraEntityFeature.STREAM

    async def stream_source(self) -> str | None:
        if self.device.is_demo:
            return None
        return self.device.rtsp_url

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        if self.device.is_demo:
            return await self.hass.async_add_executor_job(self._render_demo_frame)
        return None

    async def handle_async_mjpeg_stream(self, request):
        """Demo mode streams generated frames; real mode falls back to HA."""
        if not self.device.is_demo:
            return await super().handle_async_mjpeg_stream(request)

        async def _image_cb() -> bytes:
            return await self.hass.async_add_executor_job(self._render_demo_frame)

        return await async_get_still_stream(
            request, _image_cb, self.content_type, _DEMO_FPS_INTERVAL
        )

    # --- Demo frame rendering ---------------------------------------------
    def _render_demo_frame(self) -> bytes:
        """Draw one frame of the virtual door-camera scene.

        Graphics only — no text, so no font is bundled. All labels (name,
        status, time) are drawn by the popup in Home Assistant's own font.
        """
        from PIL import Image, ImageDraw

        t = time.time()
        state = self.device.call_state
        img = Image.new("RGB", (_FRAME_W, _FRAME_H), (15, 18, 26))
        d = ImageDraw.Draw(img)

        # Subtle floor line for a sense of depth.
        d.rectangle([0, 360, _FRAME_W, _FRAME_H], fill=(22, 26, 36))

        # A "visitor" silhouette that sways gently so the stream is clearly live.
        cx = _FRAME_W // 2 + int(18 * math.sin(t * 1.5))
        d.ellipse([cx - 48, 150, cx + 48, 246], fill=(74, 84, 104))  # head
        d.rounded_rectangle(
            [cx - 92, 250, cx + 92, 430], radius=44, fill=(60, 68, 90)
        )  # body/shoulders

        # Blinking REC dot (top-right), no text.
        if int(t * 2) % 2 == 0:
            d.ellipse([_FRAME_W - 44, 22, _FRAME_W - 28, 38], fill=(220, 60, 60))

        # Status bar at the bottom — colour only; the popup shows the wording.
        if state == STATE_RINGING:
            blink = int(t * 2) % 2 == 0
            d.rectangle([0, _FRAME_H - 24, _FRAME_W, _FRAME_H], fill=(200, 40, 40) if blink else (110, 22, 22))
        elif state == STATE_ANSWERED:
            d.rectangle([0, _FRAME_H - 24, _FRAME_W, _FRAME_H], fill=(28, 120, 60))

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return buf.getvalue()
