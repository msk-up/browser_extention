import { MESSAGE_TYPES, STATUS, STORAGE_KEYS, browserApi } from '../common/messaging.js';

let currentStatus = STATUS.IDLE;
let lastError = '';

browserApi.runtime.onInstalled.addListener(() => {
  browserApi.storage.local.set({ [STORAGE_KEYS.STATUS]: STATUS.IDLE, [STORAGE_KEYS.LAST_ERROR]: '' });
});

browserApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type } = message || {};

  if (type === MESSAGE_TYPES.STATUS_UPDATE) {
    updateStatus(message.payload?.status || STATUS.IDLE, message.payload?.error || '');
    sendResponse?.({ ok: true });
    return;
  }

  if (type === MESSAGE_TYPES.ADVICE && message.payload?.text) {
    pushAdviceToActiveTab(message.payload.text);
    sendResponse?.({ ok: true });
    return;
  }

  if (type === MESSAGE_TYPES.GET_STATUS) {
    sendResponse?.({ status: currentStatus, error: lastError });
  }
});

async function pushAdviceToActiveTab(text) {
  try {
    const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (!tab?.id) return;
    await browserApi.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.ADVICE, payload: { text } });
  } catch (err) {
    console.warn('Unable to send advice to tab', err);
  }
}

function updateStatus(status, error = '') {
  currentStatus = status;
  if (error) {
    lastError = error;
  } else if (status !== STATUS.ERROR) {
    lastError = '';
  }
  browserApi.storage.local.set({ [STORAGE_KEYS.STATUS]: status, [STORAGE_KEYS.LAST_ERROR]: lastError });
  browserApi.runtime.sendMessage(
    { type: MESSAGE_TYPES.STATUS_UPDATE, payload: { status, error: lastError } },
    () => void browserApi.runtime.lastError
  );
}
