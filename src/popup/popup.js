import { MESSAGE_TYPES, STATUS, STORAGE_KEYS, sendMessageToActiveTab } from '../common/messaging.js';

const toggleBtn = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const previewAudio = document.getElementById('preview-audio');
const previewMeta = document.getElementById('preview-meta');
const mockAdviceBtn = document.getElementById('mock-advice');

let currentStatus = STATUS.IDLE;
let lastError = '';
// Recording is handled in the background/offscreen; popup only initiates capture.

init();

async function init() {
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    const msg = event.reason?.message || event.reason || 'Unexpected error';
    currentStatus = STATUS.ERROR;
    lastError = msg;
    renderStatus(currentStatus, lastError);
  });

  const stored = await chrome.storage.local.get([STORAGE_KEYS.STATUS, STORAGE_KEYS.LAST_ERROR]);
  currentStatus = stored[STORAGE_KEYS.STATUS] || STATUS.IDLE;
  lastError = stored[STORAGE_KEYS.LAST_ERROR] || '';
  renderStatus(currentStatus, lastError);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE_TYPES.STATUS_UPDATE) {
      const status = message.payload?.status || STATUS.IDLE;
      const error = message.payload?.error || '';
      currentStatus = status;
      lastError = error;
      renderStatus(status, error);
    }

    if (message?.type === MESSAGE_TYPES.CHUNK_PREVIEW && message.payload?.dataUrl) {
      updatePreview(message.payload);
    }
  });

  toggleBtn.addEventListener('click', onToggleClick);
  mockAdviceBtn.addEventListener('click', showMockAdvice);
}

async function onToggleClick() {
  if (currentStatus === STATUS.LISTENING || currentStatus === STATUS.SENDING) {
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.STOP_LISTENING });
    currentStatus = STATUS.IDLE;
    renderStatus(currentStatus);
    return;
  }

  toggleBtn.disabled = true;
  try {
    // Trigger desktop/tab picker from visible popup for user gesture.
    const streamId = await requestDesktopStreamId();
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.START_LISTENING, payload: { streamId } }, (response) => {
        if (!response?.ok) {
          currentStatus = STATUS.ERROR;
          lastError = response?.error || 'Unable to start';
          renderStatus(currentStatus, lastError);
        } else {
          currentStatus = STATUS.LISTENING;
          renderStatus(currentStatus);
        }
        resolve();
      });
    });
  } catch (err) {
    currentStatus = STATUS.ERROR;
    lastError = err?.message || 'Capture was blocked or dismissed';
    renderStatus(currentStatus, lastError);
  } finally {
    toggleBtn.disabled = false;
  }
}

function renderStatus(status, error = '') {
  statusEl.textContent = error ? `Status: ${status} – ${error}` : `Status: ${status}`;
  const isActive = status === STATUS.LISTENING || status === STATUS.SENDING;
  toggleBtn.textContent = isActive ? 'Stop Listening' : 'Start Listening';
  toggleBtn.disabled = status === STATUS.SENDING;
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

async function requestDesktopStreamId() {
  return new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(['tab', 'audio'], (streamId) => {
      if (!streamId) {
        reject(new Error('Desktop capture prompt dismissed'));
        return;
      }
      resolve(streamId);
    });
  });
}

async function showMockAdvice() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url) || tab.url.includes('chrome.google.com/webstore')) {
    renderStatus(STATUS.ERROR, 'Open a normal page tab first, then retry mock advice');
    return;
  }

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      type: MESSAGE_TYPES.ADVICE,
      payload: { text: 'Mock tip: keep answers concise and clear.' }
    });
    renderStatus(currentStatus, 'Mock advice sent to page');
  } catch (err) {
    renderStatus(STATUS.ERROR, err?.message || 'Could not send mock advice');
  }
}

async function tryGetUserMediaSequential(list) {
  let lastErr;
  for (const constraints of list) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Unable to capture audio stream');
}

function chooseMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/contentScript.js']
    });
  } catch (err) {
    // Ignore if already injected; rethrow other errors.
    const msg = err?.message || '';
    if (!msg.includes('Cannot access a chrome:// URL') && !msg.includes('Already injected')) {
      throw err;
    }
  }
}
