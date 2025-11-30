import { MESSAGE_TYPES, STATUS } from '../common/messaging.js';

const API_URL = 'https://api.example.com/analyze-audio';
const WS_URL = ''; // Optional WebSocket endpoint for streaming audio + receiving text advice.

let mediaRecorder = null;
let stream = null;
let ws = null;
let wsReady = false;

// Swallow unexpected rejections/errors so the offscreen page doesn't crash.
self.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  console.error('Unhandled rejection in offscreen', event.reason);
  updateStatus(STATUS.ERROR, event.reason?.message || 'Unhandled rejection');
});

self.addEventListener('error', (event) => {
  event.preventDefault();
  console.error('Unhandled error in offscreen', event.error || event.message);
  updateStatus(STATUS.ERROR, event.error?.message || event.message || 'Unhandled error');
});

chrome.runtime.onMessage.addListener((message) => {
  const { type } = message || {};
  if (type === MESSAGE_TYPES.OFFSCREEN_START && message.payload?.streamId) {
    startDesktopStreamCapture(message.payload.streamId);
  }
  if (type === MESSAGE_TYPES.OFFSCREEN_STOP) {
    stopCapture();
  }
});

async function startMicCapture() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    return;
  }

  try {
    openWebSocket();
    // Use display media to capture tab/system audio via user prompt.
    // Some platforms require a video track to allow audio capture, so request minimal video then drop it.
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        systemAudio: 'include'
      },
      video: {
        displaySurface: 'browser',
        cursor: 'never'
      },
      preferCurrentTab: true
    });
    // Keep video tracks alive to avoid killing the stream; just mute them.
    stream.getVideoTracks().forEach((t) => {
      t.enabled = false;
    });

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      throw new DOMException('No audio track in shared stream', 'NotReadableError');
    }

    const mimeType = chooseMimeType();
    const options = mimeType ? { mimeType } : undefined;
    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.ondataavailable = handleChunk;
    mediaRecorder.onstop = () => cleanup();
    mediaRecorder.start(1000);
    updateStatus(STATUS.LISTENING);
  } catch (err) {
    const detail = err?.message || err?.name || String(err);
    console.error('Offscreen mic start failed', err);
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
      updateStatus(STATUS.ERROR, 'Share prompt dismissed; please allow tab/system audio');
    } else if (detail?.toLowerCase().includes('timeout')) {
      updateStatus(STATUS.ERROR, 'Display capture timed out; retry and pick the tab/system audio');
    } else if (detail?.toLowerCase().includes('no audio')) {
      updateStatus(STATUS.ERROR, 'No audio in shared stream; ensure you select a tab/system audio option');
    } else {
      updateStatus(STATUS.ERROR, detail || 'Display capture not supported in this context. Try again.');
    }
    cleanup();
  }
}

async function startDesktopStreamCapture(streamId) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopCapture();
  }

  try {
    openWebSocket();
    // Try tab-first constraints, then desktop constraints as fallback.
    const candidates = [
      {
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: false
      },
      {
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: streamId
          }
        },
        video: false
      }
    ];

    stream = await tryGetUserMediaSequential(candidates);

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      throw new DOMException('No audio track in shared stream', 'NotReadableError');
    }

    const mimeType = chooseMimeType();
    const options = mimeType ? { mimeType } : undefined;
    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.ondataavailable = handleChunk;
    mediaRecorder.onstop = () => cleanup();
    mediaRecorder.start(1000);
    updateStatus(STATUS.LISTENING);
  } catch (err) {
    const detail = err?.message || err?.name || String(err);
    console.error('Offscreen desktop capture start failed', err);
    updateStatus(STATUS.ERROR, detail || 'Display capture not supported in this context. Try again.');
    stopCapture();
  }
}

function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  closeWebSocket();
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
  broadcastChunkPreview(event.data).catch(() => {});
  updateStatus(STATUS.SENDING);

  let sendFailed = false;
  try {
    if (WS_URL) {
      await sendChunkViaWebSocket(event.data);
      // Advice should arrive via WebSocket messages.
    } else {
      const advice = await sendAudioToApi(event.data);
      if (advice) {
        pushAdvice(advice);
      }
    }
  } catch (err) {
    sendFailed = true;
    console.error('Offscreen send failed', err);
    updateStatus(STATUS.ERROR, err?.message || 'Send failed');
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    updateStatus(STATUS.LISTENING, sendFailed ? 'Send failed; still recording' : '');
  } else {
    updateStatus(STATUS.IDLE, sendFailed ? 'Send failed; recorder stopped' : '');
    stopCapture();
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
  try {
    chrome.runtime.sendMessage({
      from: 'offscreen',
      type: MESSAGE_TYPES.ADVICE,
      payload: { text }
    });
  } catch (err) {
    console.warn('Unable to send advice from offscreen', err);
  }
}

async function broadcastChunkPreview(blob) {
  try {
    const dataUrl = await blobToDataUrl(blob);
  chrome.runtime.sendMessage({
    from: 'offscreen',
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

function updateStatus(status, error) {
  try {
    chrome.runtime.sendMessage({
      from: 'offscreen',
      type: MESSAGE_TYPES.STATUS_UPDATE,
      payload: { status, error }
    });
  } catch (err) {
    console.warn('Unable to send status from offscreen', err);
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
          pushAdvice(text);
        }
      } catch (err) {
        console.warn('Offscreen WS message handling failed', err);
      }
    };
    ws.onerror = (err) => {
      console.warn('Offscreen WebSocket error', err);
    };
    ws.onclose = () => {
      wsReady = false;
      ws = null;
    };
  } catch (err) {
    console.warn('Offscreen unable to open WebSocket', err);
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
  ws.send(blob);
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

async function tryGetUserMediaSequential(constraintsList) {
  let lastErr;
  for (const constraints of constraintsList) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      return s;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('getUserMedia failed for all constraints');
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
