import { MESSAGE_TYPES, STATUS, STORAGE_KEYS, browserApi } from '../common/messaging.js';

const toggleBtn = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const previewAudio = document.getElementById('preview-audio');
const previewMeta = document.getElementById('preview-meta');
const mockAdviceBtn = document.getElementById('mock-advice');
const header = document.querySelector('h1');
const wsUrlInput = document.getElementById('ws-url');

let currentStatus = STATUS.IDLE;
let lastError = '';
let mediaRecorder = null;
let captureStream = null;
let recorderStream = null;
let ws = null;
let wsReady = false;
let wsUrl = '';

init();

async function init() {
  const stored = await browserApi.storage.local.get([
    STORAGE_KEYS.STATUS,
    STORAGE_KEYS.LAST_ERROR,
    STORAGE_KEYS.WS_URL
  ]);
  currentStatus = stored[STORAGE_KEYS.STATUS] || STATUS.IDLE;
  lastError = stored[STORAGE_KEYS.LAST_ERROR] || '';
  wsUrl = stored[STORAGE_KEYS.WS_URL] || '';
  if (wsUrlInput) wsUrlInput.value = wsUrl;
  renderStatus(currentStatus, lastError);

  browserApi.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE_TYPES.STATUS_UPDATE) {
      const status = message.payload?.status || STATUS.IDLE;
      const error = message.payload?.error || '';
      currentStatus = status;
      lastError = error;
      renderStatus(status, error);
    }
  });

  toggleBtn.addEventListener('click', onToggleClick);
  mockAdviceBtn.addEventListener('click', sendMockAdvice);
  wsUrlInput?.addEventListener('change', onWsUrlChange);
  // Keep the popup alive by pinning timers; Chrome will still close on blur but this reduces GC sleeps.
  setInterval(() => chrome.runtime?.getPlatformInfo?.(() => {}), 20000);

  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    lastError = event.reason?.message || event.reason || 'Unexpected error';
    currentStatus = STATUS.ERROR;
    renderStatus(currentStatus, lastError);
  });
}

async function onToggleClick() {
  if (currentStatus === STATUS.LISTENING || currentStatus === STATUS.SENDING) {
    stopRecording();
    return;
  }

  toggleBtn.disabled = true;
  try {
    const stream = await requestSystemStream();
    await startRecording(stream);
  } catch (err) {
    currentStatus = STATUS.ERROR;
    lastError = err?.message || 'Capture prompt dismissed';
    renderStatus(currentStatus, lastError);
  } finally {
    toggleBtn.disabled = false;
  }
}

function renderStatus(status, error = '') {
  const active = status === STATUS.LISTENING || status === STATUS.SENDING;
  header.classList.toggle('active', active);
  toggleBtn.textContent = active ? 'Stop Listening' : 'Start Listening';
  toggleBtn.disabled = status === STATUS.SENDING;
  statusEl.textContent = error ? `Status: ${status} – ${error}` : `Status: ${status}`;
}

function updatePreview(payload) {
  try {
    previewAudio.src = payload.dataUrl;
    previewAudio.load();
    const kb = Math.round((payload.size || 0) / 1024);
    const time = new Date(payload.ts || Date.now()).toLocaleTimeString();
    previewMeta.textContent = `Last chunk: ${kb} KB · ${payload.mime || 'audio/webm'} · ${time}`;
  } catch (_err) {
    // ignore preview errors
  }
}

async function requestSystemStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('System capture not supported in this browser');
  }
  return navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
}

async function startRecording(stream) {
  captureStream = stream;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    throw new Error('No audio track in shared stream. Ensure "Share tab audio" is enabled in the picker.');
  }
  // Keep original stream alive; record only audio tracks.
  recorderStream = new MediaStream(audioTracks);

  // Stop if the shared tracks end (user stops sharing).
  captureStream.getTracks().forEach((t) => {
    t.onended = () => stopRecording('Capture ended');
  });

  const mimeType = chooseMimeType();
  const options = mimeType ? { mimeType } : undefined;
  try {
    mediaRecorder = new MediaRecorder(recorderStream, options);
  } catch (err) {
    cleanup();
    throw err;
  }
  mediaRecorder.ondataavailable = handleChunk;
  mediaRecorder.onstop = cleanup;
  mediaRecorder.onerror = (event) => {
    const msg = event?.error?.message || event?.error?.name || 'Recorder error';
    stopRecording(msg);
  };
  mediaRecorder.start(4000); // emit larger 4s chunks for easier listening
  openWebSocket();
  currentStatus = STATUS.LISTENING;
  lastError = '';
  renderStatus(currentStatus, lastError);
  safeSendStatus(currentStatus, '');
}

function stopRecording(reason = '') {
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  } catch (err) {
    console.warn('Stop recorder failed', err);
  } finally {
    cleanup(); // stop tracks but keep preview element intact
    currentStatus = STATUS.IDLE;
    lastError = reason || '';
    renderStatus(currentStatus, lastError);
    safeSendStatus(currentStatus, lastError);
    closeWebSocket();
  }
}

function cleanup() {
  if (captureStream) {
    captureStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (_err) {
        // ignore
      }
    });
  }
  captureStream = null;
  if (recorderStream) {
    recorderStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (_err) {
        // ignore
      }
    });
  }
  recorderStream = null;
  mediaRecorder = null;
}

async function handleChunk(event) {
  if (!event.data || event.data.size === 0) return;
  updatePreview({
    dataUrl: await blobToDataUrl(event.data),
    size: event.data.size,
    mime: event.data.type || 'audio/webm',
    ts: Date.now()
  });
  if (wsReady && ws) {
    try {
      ws.send(event.data);
    } catch (err) {
      wsReady = false;
      lastError = err?.message || 'WebSocket send failed';
      renderStatus(currentStatus, lastError);
    }
  }
}

async function sendMockAdvice() {
  try {
    const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url) || tab.url.includes('chrome.google.com/webstore')) {
      renderStatus(STATUS.ERROR, 'Open a normal page tab first, then retry mock advice');
      return;
    }
    await ensureContentScript(tab.id);
    await browserApi.tabs.sendMessage(tab.id, {
      type: MESSAGE_TYPES.ADVICE,
      payload: { text: 'Mock advice: keep answers concise and listen actively.' }
    });
    renderStatus(currentStatus, 'Mock advice sent');
  } catch (err) {
    renderStatus(STATUS.ERROR, err?.message || 'Could not send mock advice');
  }
}

async function ensureContentScript(tabId) {
  try {
    if (browserApi.scripting?.executeScript) {
      await browserApi.scripting.executeScript({
        target: { tabId },
        files: ['src/content/contentScript.js']
      });
    } else if (browserApi.tabs?.executeScript) {
      await browserApi.tabs.executeScript(tabId, { file: 'src/content/contentScript.js' });
    }
  } catch (err) {
    const msg = err?.message || '';
    if (!msg.includes('Cannot access a chrome:// URL') && !msg.includes('Already injected')) {
      throw err;
    }
  }
}

function chooseMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  const mime = blob.type || 'application/octet-stream';
  return `data:${mime};base64,${base64}`;
}

function safeSendStatus(status, error) {
  // In MV3 the service worker may be asleep; ignore missing receiver errors.
  if (!browserApi?.runtime?.sendMessage) return;
  browserApi.runtime.sendMessage({ type: MESSAGE_TYPES.STATUS_UPDATE, payload: { status, error } }, () => {
    void browserApi.runtime.lastError;
  });
}

function onWsUrlChange() {
  wsUrl = wsUrlInput?.value?.trim() || '';
  browserApi.storage.local.set({ [STORAGE_KEYS.WS_URL]: wsUrl });
  if (!wsUrl) {
    closeWebSocket();
  }
}

function openWebSocket() {
  closeWebSocket();
  if (!wsUrl) return;
  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      wsReady = true;
      renderStatus(currentStatus, lastError);
    };
    ws.onerror = (event) => {
      wsReady = false;
      lastError = event?.message || 'WebSocket error';
      renderStatus(currentStatus, lastError);
    };
    ws.onclose = () => {
      wsReady = false;
      ws = null;
    };
  } catch (err) {
    wsReady = false;
    lastError = err?.message || 'WebSocket connect failed';
    renderStatus(currentStatus, lastError);
  }
}

function closeWebSocket() {
  if (ws) {
    try {
      ws.close();
    } catch (_err) {
      // ignore
    }
  }
  ws = null;
  wsReady = false;
}
