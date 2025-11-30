export const MESSAGE_TYPES = {
  START_LISTENING: 'START_LISTENING',
  STOP_LISTENING: 'STOP_LISTENING',
  STATUS_UPDATE: 'STATUS_UPDATE',
  GET_STATUS: 'GET_STATUS',
  ADVICE: 'ADVICE',
  OFFSCREEN_START: 'OFFSCREEN_START',
  OFFSCREEN_STOP: 'OFFSCREEN_STOP',
  CHUNK_PREVIEW: 'CHUNK_PREVIEW',
  START_DESKTOP_CAPTURE: 'START_DESKTOP_CAPTURE',
  POPUP_CHUNK: 'POPUP_CHUNK'
};

export const STATUS = {
  IDLE: 'Idle',
  LISTENING: 'Listening…',
  SENDING: 'Sending audio…',
  ERROR: 'Error'
};

export const STORAGE_KEYS = {
  STATUS: 'status',
  LAST_ERROR: 'lastError'
};

export async function sendMessageToActiveTab(message) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs?.[0];
  }
  if (!tab?.id) return;
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}
