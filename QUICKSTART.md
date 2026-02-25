# Quick Start

## 1) Start Service

```bash
cd /home/zed/src/prolific-watcher
go run main.go
```

## 2) Load Extension (Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on...`
3. Select `localstorage-extension/manifest.json`

## 3) Open Prolific

Keep at least one `*.prolific.com` tab open.

The extension automatically:
- syncs token to `POST /receive-token`
- captures studies headers to `POST /receive-studies-headers`
- captures studies response bodies to `POST /receive-studies-response` (Firefox)
- posts refresh metadata to `POST /receive-studies-refresh`

## 4) Verify

```bash
curl http://localhost:8080/status
curl http://localhost:8080/studies-headers
curl -X POST http://localhost:8080/studies/refresh
curl http://localhost:8080/studies-live
curl 'http://localhost:8080/study-events?limit=50'
```
