import { MESSAGE_TYPES, STATUS, STORAGE_KEYS } from '../common/messaging.js';

const API_URL = 'https://api.example.com/analyze-audio';
const WS_URL = ''; // Optional: set to WebSocket endpoint for streaming audio + receiving text advice.
const STREAM_URL = ''; // Deprecated: prefer WS_URL for bi-directional streaming.
const ENABLE_MIC_FALLBACK = false; // Only capture tab/system audio; mic fallback disabled.

let mediaRecorder = null;
let capturedStream = null;
let capturedTabId = null;
let currentStatus = STATUS.IDLE;
let usingOffscreen = false;
let lastError = '';
let adviceStream = null;
let ws = null;
let wsReady = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ [STORAGE_KEYS.STATUS]: STATUS.IDLE });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type } = message || {};

  // Messages coming back from the offscreen document.
  if (message?.from === 'offscreen') {
    if (type === MESSAGE_TYPES.ADVICE && message.payload?.text) {
      pushAdviceToContent(message.payload.text);
    }
    if (type === MESSAGE_TYPES.STATUS_UPDATE && message.payload?.status) {
      updateStatus(message.payload.status, message.payload.error);
      if (message.payload.status === STATUS.IDLE) {
        usingOffscreen = false;
      }
    }
    return;
  }

  if (type === MESSAGE_TYPES.START_LISTENING) {
    startListening(message?.payload?.streamId).then(() => sendResponse({ ok: true })).catch((err) => {
      console.error('startListening failed', err);
      updateStatus(STATUS.ERROR, err.message);
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (type === MESSAGE_TYPES.STOP_LISTENING) {
    stopListening();
    sendResponse({ ok: true });
  }

  if (type === MESSAGE_TYPES.GET_STATUS) {
    sendResponse({ status: currentStatus });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturedTabId) {
    stopListening();
  }
});

async function startListening(externalStreamId) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found');
  }

  capturedTabId = tab.id;
  openWebSocket();

  if (externalStreamId) {
    // Recording handled in offscreen using the provided streamId.
    await ensureOffscreenDocument();
    usingOffscreen = true;
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OFFSCREEN_START,
      payload: { streamId: externalStreamId }
    });
    updateStatus(STATUS.LISTENING);
    startAdviceStream();
    return;
  }

  if (typeof chrome.tabCapture?.capture === 'function') {
    const stream = await captureAudioStream(capturedTabId);
    capturedStream = stream;

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = handleAudioChunk;
    mediaRecorder.onstop = cleanup;
    // Streamy capture: emit small chunks frequently.
    mediaRecorder.start(1000);
    updateStatus(STATUS.LISTENING);
    startAdviceStream();
    return;
  }

  // No tabCapture and no external stream provided.
  throw new Error('Tab capture unavailable; please start from popup and approve sharing.');
}

function stopListening() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (usingOffscreen) {
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_STOP });
    usingOffscreen = false;
  }
  stopAdviceStream();
  closeWebSocket();
  cleanup();
  updateStatus(STATUS.IDLE);
}

function cleanup() {
  if (capturedStream) {
    capturedStream.getTracks().forEach((track) => track.stop());
  }
  capturedStream = null;
  mediaRecorder = null;
  capturedTabId = null;
  usingOffscreen = false;
}

async function captureAudioStream(tabId) {
  if (typeof chrome.tabCapture?.capture !== 'function') {
    throw new Error('tabCapture API not available in this browser build');
  }

  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture(
      {
        audio: true,
        video: false,
        targetTabId: tabId,
        audioConstraints: {
          mandatory: {
            chromeMediaSource: 'tab'
          }
        },
        // Align with common tabCapture usage from Chrome docs/StackOverflow.
        // Explicitly request high-quality mono capture for speech.
        constraint: { audio: true }
      },
      (stream) => {
        if (chrome.runtime.lastError || !stream) {
          reject(new Error(chrome.runtime.lastError?.message || 'Could not capture tab audio'));
          return;
        }
        resolve(stream);
      }
    );
  });
}

async function startOffscreenDisplayCapture() {
  usingOffscreen = true;
  await ensureOffscreenDocument();
  updateStatus(STATUS.LISTENING);
  await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_START });
  startAdviceStream();
  openWebSocket();
}

function stopOffscreenDisplayCapture() {
  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_STOP });
  stopAdviceStream();
  closeWebSocket();
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('src/offscreen/offscreen.html');
  if (chrome.offscreen?.hasDocument) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
      justification: 'Capture tab/system audio when tabCapture is unavailable'
    });
  } catch (err) {
    // If the document already exists, ignore; otherwise rethrow.
    if (!String(err?.message || '').includes('already exists')) {
      throw err;
    }
  }
}

async function handleAudioChunk(event) {
  if (!event.data || event.data.size === 0) return;
  await processIncomingBlob(event.data);
}

async function processIncomingBlob(blob) {
  if (!blob || blob.size === 0) return;
  try {
    broadcastChunkPreview(blob).catch(() => {});
    updateStatus(STATUS.SENDING);

    if (WS_URL) {
      await sendChunkViaWebSocket(blob);
      // Advice expected via WebSocket messages.
    } else {
      const advice = await sendAudioToApi(blob);
      if (advice) {
        await pushAdviceToContent(advice);
      }
    }
  } catch (err) {
    console.error('Failed to send audio', err);
    updateStatus(STATUS.ERROR, err.message || 'Send failed');
  } finally {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      updateStatus(STATUS.LISTENING);
    } else {
      updateStatus(STATUS.IDLE);
    }
  }
}

async function sendAudioToApi(blob) {
  const formData = new FormData();
  formData.append('audio', blob, 'chunk.webm');

  const response = await fetch(API_URL, {
    method: 'POST',
    body: formData
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || 'Backend request failed');
  }

  try {
    const data = JSON.parse(text);
    return data.advice || data.message || text;
  } catch (_err) {
    return text;
  }
}

async function pushAdviceToContent(advice) {
  if (!capturedTabId) return;
  try {
    await chrome.tabs.sendMessage(capturedTabId, {
      type: MESSAGE_TYPES.ADVICE,
      payload: { text: advice }
    });
  } catch (err) {
    console.warn('Unable to send advice to content script', err);
  }
}

function startAdviceStream() {
  stopAdviceStream();
  if (!STREAM_URL) return;
  try {
    adviceStream = new EventSource(STREAM_URL);
    adviceStream.onmessage = (event) => {
      const text = event?.data;
      if (text) {
        pushAdviceToContent(text);
      }
    };
    adviceStream.onerror = (err) => {
      console.warn('Advice stream error', err);
    };
  } catch (err) {
    console.warn('Unable to start advice stream', err);
  }
}

function stopAdviceStream() {
  if (adviceStream) {
    adviceStream.close?.();
  }
  adviceStream = null;
}

function startDesktopCaptureFallback() {
  return new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(
      ['tab', 'audio'],
      (streamId, options) => {
        if (!streamId) {
          reject(new Error('Desktop capture prompt dismissed'));
          return;
        }
        // Pass streamId to offscreen to start recording.
        ensureOffscreenDocument()
          .then(() => {
            usingOffscreen = true;
            updateStatus(STATUS.LISTENING);
            chrome.runtime.sendMessage({
              type: MESSAGE_TYPES.OFFSCREEN_START,
              payload: { streamId, options }
            });
            startAdviceStream();
            openWebSocket();
            resolve();
          })
          .catch(reject);
      }
    );
  });
}

async function startDesktopStreamWithId(streamId) {
  await ensureOffscreenDocument();
  usingOffscreen = true;
  updateStatus(STATUS.LISTENING);
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.OFFSCREEN_START,
    payload: { streamId }
  });
  startAdviceStream();
  openWebSocket();
}

function openWebSocket() {
  closeWebSocket();
  if (!WS_URL) return;
  try {
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      wsReady = true;
    };
    ws.onmessage = async (event) => {
      try {
        const text = await extractText(event.data);
        if (text) {
          pushAdviceToContent(text);
        }
      } catch (err) {
        console.warn('WS message handling failed', err);
      }
    };
    ws.onerror = (err) => {
      console.warn('WebSocket error', err);
    };
    ws.onclose = () => {
      wsReady = false;
      ws = null;
    };
  } catch (err) {
    console.warn('Unable to open WebSocket', err);
  }
}

function closeWebSocket() {
  if (ws) {
    ws.close?.();
  }
  ws = null;
  wsReady = false;
}

async function sendChunkViaWebSocket(blob) {
  if (!wsReady) {
    openWebSocket();
  }
  if (!wsReady || !ws) {
    throw new Error('WebSocket not connected');
  }
  try {
    ws.send(blob);
  } catch (err) {
    console.warn('WebSocket send failed', err);
    throw err;
  }
}

async function extractText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  return '';
}

async function broadcastChunkPreview(blob) {
  try {
    const dataUrl = await blobToDataUrl(blob);
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CHUNK_PREVIEW,
      payload: {
        size: blob.size,
        mime: blob.type || 'audio/webm',
        dataUrl,
        ts: Date.now()
      }
    });
  } catch (_err) {
    // ignore preview failures
  }
}

async function blobToDataUrl(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  const mime = blob.type || 'application/octet-stream';
  return `data:${mime};base64,${base64}`;
}

function updateStatus(status, errorMessage = '') {
  currentStatus = status;
  if (errorMessage) {
    lastError = errorMessage;
  } else if (status !== STATUS.ERROR) {
    lastError = '';
  }
  chrome.storage.local.set({ [STORAGE_KEYS.STATUS]: status, [STORAGE_KEYS.LAST_ERROR]: lastError });
  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.STATUS_UPDATE, payload: { status, error: lastError } }, () => {
    // Suppress errors when no listeners exist.
    void chrome.runtime.lastError;
  });
}
