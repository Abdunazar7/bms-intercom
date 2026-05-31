"""Constants for the BMS Intercom integration."""
from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "bms_intercom"

# Custom config keys (host/username/password/name use Home Assistant's own keys)
CONF_MODE = "mode"
CONF_RTSP_PORT = "rtsp_port"
CONF_HTTP_PORT = "http_port"
CONF_DOOR_NO = "door_no"

# Modes
MODE_DEMO = "demo"
MODE_REAL = "real"

# Defaults
DEFAULT_NAME = "Домофон"
DEFAULT_RTSP_PORT = 554
DEFAULT_HTTP_PORT = 80
DEFAULT_DOOR_NO = 1

# How often (seconds) to poll the panel for call status in real mode.
CALL_POLL_INTERVAL = 1.5

PLATFORMS: list[Platform] = [
    Platform.CAMERA,
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
]

# RTSP main stream path (channel 101 = main, 102 = sub).
RTSP_STREAM_PATH = "/Streaming/Channels/101"

# Dispatcher signal — entities re-render when device state changes.
SIGNAL_STATE_UPDATED = f"{DOMAIN}_state_updated_{{}}"
