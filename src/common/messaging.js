export const MESSAGE_TYPES = {
  START_LISTENING: 'START_LISTENING',
  STOP_LISTENING: 'STOP_LISTENING',
  STATUS_UPDATE: 'STATUS_UPDATE',
  ADVICE: 'ADVICE',
  CHUNK_PREVIEW: 'CHUNK_PREVIEW'
};

export const STATUS = {
  IDLE: 'Idle',
  LISTENING: 'Listening…',
  SENDING: 'Sending audio…',
  ERROR: 'Error'
};

export const STORAGE_KEYS = {
  STATUS: 'status',
  LAST_ERROR: 'lastError',
  WS_URL: 'wsUrl'
};

export const browserApi = (() => {
  if (typeof browser !== 'undefined') return browser;
  if (typeof chrome !== 'undefined') return chrome;
  throw new Error('WebExtension API not found');
})();

export async function sendMessageToActiveTab(message) {
  const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!tab?.id) return;
  return browserApi.tabs.sendMessage(tab.id, message);
}
