export const MESSAGE_TYPES = {
  START_LISTENING: 'START_LISTENING',
  STOP_LISTENING: 'STOP_LISTENING',
  STATUS_UPDATE: 'STATUS_UPDATE',
  GET_STATUS: 'GET_STATUS',
  ADVICE: 'ADVICE',
  OFFSCREEN_START: 'OFFSCREEN_START',
  OFFSCREEN_STOP: 'OFFSCREEN_STOP'
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  return chrome.tabs.sendMessage(tab.id, message);
}
