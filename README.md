# Prolific Watcher

Local Prolific companion with:

- live cached studies
- recent availability events
- tracked submission state

## Setup

1. Start backend:

```bash
go run .
```

2. Load extension:

- Open `about:debugging#/runtime/this-firefox`
- Click `Load Temporary Add-on...`
- Select `localstorage-extension/manifest.json`

3. Open Prolific and stay logged in.
4. Open extension popup.

## Daily Use

- Keep the backend running.
- Keep Firefox open with Prolific logged in.
- Open the popup to monitor studies, feed activity, and submissions.

## Troubleshooting

- If popup data stops updating, confirm backend is running on `http://localhost:8080`.
- Reload the extension from `about:debugging`.
- Re-open a Prolific tab, then reopen the popup.
