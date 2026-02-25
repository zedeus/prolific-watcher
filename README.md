# Prolific Watcher

Local Go service + Firefox extension for tracking Prolific studies with live updates.

## What It Does

The extension:
- scans open Prolific tabs
- reads `oidc.user...` from `localStorage`
- extracts `access_token` and sends it to the Go service
- captures studies request headers (`/api/v1/participant/studies/`)
- captures studies response bodies in Firefox (`filterResponseData`) and sends them to backend
- watches `https://auth.prolific.com/oauth/token` and syncs refreshed token when possible

The Go service persists everything in SQLite:
- token state
- captured studies headers
- studies history
- latest studies by id
- active study snapshot
- availability events (`available` / `unavailable`)
- latest studies refresh metadata

## Repo Layout

- `main.go` - bootstrap server + DB
- `service.go` - route wiring
- `handlers.go` - HTTP handlers, ingest logic, refresh logic
- `stores.go` - SQLite stores
- `studies_parser.go` - studies normalization
- `stream.go` - SSE stream (`/events/stream`)
- `localstorage-extension/` - extension background + popup UI

## Endpoints

- `GET /` - service overview
- `GET /healthz`
- `GET /status`
- `GET /token`
- `POST /receive-token`
- `POST /receive-studies-headers`
- `POST /receive-studies-refresh`
- `POST /receive-studies-response`
- `GET /studies-headers`
- `GET /studies-refresh`
- `GET /events/stream`
- `GET /study-events`
- `GET /studies` - cached current available studies
- `GET /studies-live` - alias for live popup fetch
- `POST /studies/refresh` - force upstream fetch + persist + reconcile

## Run

```bash
cd /home/zed/src/prolific-watcher
go run main.go
```

Service: `http://localhost:8080`  
DB: `prolific_watcher.db`

## Firefox Setup

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on...`
3. Select `localstorage-extension/manifest.json`
4. Keep at least one Prolific tab open (can stay in background)

## Quick Validation

```bash
curl http://localhost:8080/status
curl http://localhost:8080/studies-headers
curl -X POST http://localhost:8080/studies/refresh
curl http://localhost:8080/studies-live
curl 'http://localhost:8080/study-events?limit=50'
curl http://localhost:8080/studies-refresh
```

## Notes

- Sensitive local auth/state is stored in SQLite.
- Browser response-body interception is Firefox-focused (`webRequestFilterResponse`).
