import { MESSAGE_TYPES, STATUS } from '../common/messaging.js';

const API_URL = 'https://api.example.com/analyze-audio';

let mediaRecorder = null;
let stream = null;

chrome.runtime.onMessage.addListener((message) => {
  const { type } = message || {};
  if (type === MESSAGE_TYPES.OFFSCREEN_START) {
    startMicCapture();
  }
  if (type === MESSAGE_TYPES.OFFSCREEN_STOP) {
    stopMicCapture();
  }
});

async function startMicCapture() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = handleChunk;
    mediaRecorder.onstop = () => cleanup();
    mediaRecorder.start(4000);
    updateStatus(STATUS.LISTENING);
  } catch (err) {
    const detail = err?.message || err?.name || String(err);
    console.error('Offscreen mic start failed', err);
    updateStatus(STATUS.ERROR, detail);
  }
}

function stopMicCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  cleanup();
  updateStatus(STATUS.IDLE);
}

function cleanup() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
  }
  stream = null;
  mediaRecorder = null;
}

async function handleChunk(event) {
  if (!event.data || event.data.size === 0) return;
  try {
    updateStatus(STATUS.SENDING);
    const advice = await sendAudioToApi(event.data);
    if (advice) {
      pushAdvice(advice);
    }
  } catch (err) {
    console.error('Offscreen send failed', err);
    updateStatus(STATUS.ERROR, err?.message);
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

function pushAdvice(text) {
  chrome.runtime.sendMessage({
    from: 'offscreen',
    type: MESSAGE_TYPES.ADVICE,
    payload: { text }
  });
}

function updateStatus(status, error) {
  chrome.runtime.sendMessage({
    from: 'offscreen',
    type: MESSAGE_TYPES.STATUS_UPDATE,
    payload: { status, error }
  });
}
