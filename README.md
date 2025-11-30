# Meeting Coach (Chrome Extension, Manifest V3)

Minimal MVP that captures audio from your current meeting tab, sends it to a backend, and overlays the returned advice on the page.

## How it works
- Click the extension icon. Use **Start Listening** / **Stop Listening** in the popup.
- The background service worker captures the active tab's audio via `chrome.tabCapture` and records chunks with `MediaRecorder` every ~4s.
- If `tabCapture` is not available (some Chromium builds), it falls back to an offscreen document that captures your microphone and streams chunks instead.
- Optional: set `WS_URL` in `src/background/serviceWorker.js` to a WebSocket endpoint to stream audio chunks out and receive live text advice back. (SSE `STREAM_URL` is deprecated.)
- Each chunk is POSTed to `https://api.example.com/analyze-audio` (update `API_URL` in `src/background/serviceWorker.js`). The endpoint should accept `multipart/form-data` with field `audio` (WebM/Opus).
- The backend response body is treated as text; if JSON, fields `advice` or `message` are used.
- Advice is sent to the content script and shown as a small snackbar in the bottom-right corner of the page.

## Project structure
```
manifest.json
src/
  background/serviceWorker.js   // tab capture, recording, backend calls, messaging
  popup/popup.html & popup.js   // user control + status
  content/contentScript.js      // overlay/snackbar UI
  common/messaging.js           // shared message + status constants
assets/icons/icon-*.png         // 16, 32, 48, 128 px
```

## Setup / Load
1. Open Chrome -> `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** -> select this project folder.
4. Pin the extension, open a meeting tab, and click **Start Listening**.

## Configuration
































































- Backend URL: change `API_URL` in `src/background/serviceWorker.js`.
- Chunk duration: adjust `mediaRecorder.start(4000)` (milliseconds) in the same file.
- Overlay timing: change `DISPLAY_DURATION` in `src/content/contentScript.js`.
- If tab capture is unavailable in your browser build, the extension falls back to a user prompt (desktop capture picker) to grab tab/system audio.
- Live stream: set `WS_URL` in `src/background/serviceWorker.js` and `src/offscreen/offscreen.js` to your WebSocket endpoint (bi-directional audio chunks + advice). Leave empty to disable.

## Notes
- Mic/tab permission prompts appear on first capture.
- The service worker stops recording if the captured tab closes.
- This is an MVP; add retries/auth, richer error UI, and stricter tab checks before production use.
