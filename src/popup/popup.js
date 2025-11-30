import { MESSAGE_TYPES, STATUS, STORAGE_KEYS, browserApi } from '../common/messaging.js';

const toggleBtn = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const previewAudio = document.getElementById('preview-audio');
const previewMeta = document.getElementById('preview-meta');
const mockAdviceBtn = document.getElementById('mock-advice');
const header = document.querySelector('h1');

let currentStatus = STATUS.IDLE;
let lastError = '';
let mediaRecorder = null;
let captureStream = null;

init();

async function init() {
  const stored = await browserApi.storage.local.get([STORAGE_KEYS.STATUS, STORAGE_KEYS.LAST_ERROR]);
  currentStatus = stored[STORAGE_KEYS.STATUS] || STATUS.IDLE;
  lastError = stored[STORAGE_KEYS.LAST_ERROR] || '';
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
    const stream = await requestMicrophoneStream();
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

async function requestMicrophoneStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture not supported in this browser');
  }
  return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

async function startRecording(stream) {
  captureStream = stream;
  const mimeType = chooseMimeType();
  const options = mimeType ? { mimeType } : undefined;
  mediaRecorder = new MediaRecorder(stream, options);
  mediaRecorder.ondataavailable = handleChunk;
  mediaRecorder.onstop = cleanup;
  mediaRecorder.start(4000); // emit larger 4s chunks for easier listening
  currentStatus = STATUS.LISTENING;
  lastError = '';
  renderStatus(currentStatus, lastError);
  browserApi.runtime.sendMessage({ type: MESSAGE_TYPES.STATUS_UPDATE, payload: { status: currentStatus, error: '' } });
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  currentStatus = STATUS.IDLE;
  renderStatus(currentStatus);
  browserApi.runtime.sendMessage({ type: MESSAGE_TYPES.STATUS_UPDATE, payload: { status: currentStatus, error: '' } });
}

function cleanup() {
  if (captureStream) {
    captureStream.getTracks().forEach((t) => t.stop());
  }
  captureStream = null;
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
  // Backend disabled; no send.
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
