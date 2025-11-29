import { MESSAGE_TYPES, STATUS, STORAGE_KEYS } from '../common/messaging.js';

const API_URL = 'https://api.example.com/analyze-audio';

let mediaRecorder = null;
let capturedStream = null;
let capturedTabId = null;
let currentStatus = STATUS.IDLE;
let usingOffscreen = false;
let lastError = '';

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
    startListening().then(() => sendResponse({ ok: true })).catch((err) => {
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

async function startListening() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found');
  }

  capturedTabId = tab.id;

  if (typeof chrome.tabCapture?.capture === 'function') {
    const stream = await captureAudioStream();
    capturedStream = stream;

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = handleAudioChunk;
    mediaRecorder.onstop = cleanup;
    mediaRecorder.start(4000);
    updateStatus(STATUS.LISTENING);
    return;
  }

  // Fallback: capture microphone in an offscreen document.
  await startOffscreenMicCapture();
}

function stopListening() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (usingOffscreen) {
    stopOffscreenMicCapture();
  }
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

async function captureAudioStream() {
  if (typeof chrome.tabCapture?.capture !== 'function') {
    throw new Error('tabCapture API not available in this browser build');
  }

  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture(
      {
        audio: true,
        video: false,
        audioConstraints: {
          mandatory: {
            chromeMediaSource: 'tab'
          }
        }
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

async function startOffscreenMicCapture() {
  usingOffscreen = true;
  await ensureOffscreenDocument();
  updateStatus(STATUS.LISTENING);
  await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_START });
}

function stopOffscreenMicCapture() {
  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OFFSCREEN_STOP });
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
      reasons: ['USER_MEDIA'],
      justification: 'Capture microphone audio when tabCapture is unavailable'
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
  try {
    updateStatus(STATUS.SENDING);
    const advice = await sendAudioToApi(event.data);
    if (advice) {
      await pushAdviceToContent(advice);
    }
    
  } catch (err) {
    console.error('Failed to send audio', err);
    updateStatus(STATUS.ERROR, err.message);
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
