# Prolific Watcher Extension

Firefox extension for syncing Prolific activity to the local Prolific Watcher app.

## What It Does

- Captures OIDC token from Prolific tab localStorage and syncs token to backend.
- Captures studies request headers from Prolific API requests.
- Tracks studies and submission updates for the popup dashboard.
- Auto-open of Prolific tab is configurable from popup settings.

## Install (Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on...`
3. Select `manifest.json` in this folder

## Use

- Keep the backend app running.
- Stay logged into Prolific in Firefox.
- Open the extension popup to view live studies, activity feed, and submissions.
