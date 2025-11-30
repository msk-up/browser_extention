# whispas (Mic-only)

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
  popup/popup.html/js/css    # popup UI + recorder + preview + WS input
  control/control.html/js    # persistent control window (same UI/logic)
assets/icons/icon-*.png      # icons
```

## Load
1) chrome://extensions → enable Developer mode.
2) Load unpacked → select this folder.
3) Pin the extension, click whispas. Use **Open Control Window** for a persistent UI that won't auto-close; start listening there, approve sharing, and (optionally) set a WS URL to stream chunks.

## Notes
- Permissions: tabs, activeTab, scripting, storage, host <all_urls>. Audio access is granted via the user prompt when recording starts (ensure you tick “Share tab audio” in the picker).
- Backend streaming is commented out; enable by wiring API_URL/WS_URL in code if needed.
