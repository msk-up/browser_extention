# Meeting Coach (Mic-only)

Mic-only build: records microphone audio in the popup (1s chunks) and overlays advice on the active page.

## How it works
- Click the extension icon → **Start Listening**. Grant microphone access when prompted.
- The popup records 1s audio chunks (audio/webm) and shows the latest chunk preview. Backend sending is disabled; chunks are not uploaded.
- Mock advice sends a snackbar to the active tab for testing. Advice overlay is rendered by the content script on all pages.

## Project structure
```
manifest.json                # MV3
src/
  common/messaging.js        # shared constants + browser API helper
  background/serviceWorker.js# status/advice relay
  content/contentScript.js   # snackbar overlay
  popup/popup.html/js        # UI + mic recorder + preview
assets/icons/icon-*.png      # icons
```

## Load
1) chrome://extensions → enable Developer mode.
2) Load unpacked → select this folder.
3) Pin the extension, click Meeting Coach, grant mic, and start listening.

## Notes
- Permissions: tabs, activeTab, scripting, storage, host <all_urls>. Audio access is granted via the user prompt when recording starts (ensure you tick “Share tab audio” in the picker).
- Backend streaming is commented out; enable by wiring API_URL/WS_URL in code if needed.
