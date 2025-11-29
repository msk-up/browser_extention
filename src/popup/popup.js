import { MESSAGE_TYPES, STATUS, STORAGE_KEYS } from '../common/messaging.js';

const toggleBtn = document.getElementById('toggle');
const statusEl = document.getElementById('status');

let currentStatus = STATUS.IDLE;
let lastError = '';

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
  });

  toggleBtn.addEventListener('click', onToggleClick);
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
    await requestMicOnce();
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.START_LISTENING }, (response) => {
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
    lastError = err?.message || 'Microphone permission blocked';
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

async function requestMicOnce() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    throw new Error(err?.message || err?.name || 'Microphone permission blocked');
  }
}
