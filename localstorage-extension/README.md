# Prolific Watcher Extension

Firefox extension for background token + studies traffic sync.

## Sends Data To

- `POST http://localhost:8080/receive-token`
- `POST http://localhost:8080/receive-studies-headers`
- `POST http://localhost:8080/receive-studies-refresh`
- `POST http://localhost:8080/receive-studies-response` (when response-body capture is supported)

## Install (Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on...`
3. Choose `manifest.json` in this folder

## Behavior

- Automatic background sync on startup/install/alarm/tab updates.
- Always re-sends current token when read.
- Captures studies request headers passively.
- Captures studies response bodies via `webRequestFilterResponse`.
- Auto-open Prolific tab can be toggled in popup settings.

## Popup

Tabs:
- `Live` - current cached studies
- `Feed` - availability event history
- `Settings` - toggle + full debug panel

Debug panel shows capture support, counters, and recent debug log entries.
