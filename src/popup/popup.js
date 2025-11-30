import { MESSAGE_TYPES, STATUS, STORAGE_KEYS, browserApi } from '../common/messaging.js';

const toggleBtn = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const previewAudio = null;
const previewMeta = null;
const previewAudioMic = null;
const previewMetaMic = null;
const mockAdviceBtn = document.getElementById('mock-advice');
const header = document.querySelector('h1');
const openControlBtn = document.getElementById('open-control');
const captionInput = document.getElementById('caption-input');
const scoreField = document.getElementById('score-field');

let currentStatus = STATUS.IDLE;
let lastError = '';
let mediaRecorder = null;
let captureStream = null;
let recorderStream = null;
let ws = null;
let wsReady = false;
// Default endpoints aligned with working Python sample.
let wsUrl = 'ws://3.77.202.1:5147/ws/system';
let lastPageTabId = null;
let wsConfigSent = false;
let micWs = null;
let micWsReady = false;
let micWsUrl = 'ws://3.77.202.1:5147/ws/mic';
let micWsConfigSent = false;
let micStream = null;
let micContext = null;
let micProcessor = null;
let micBufferedSamples = [];
let micBufferedCount = 0;
let textWs = null;
let textWsReady = false;
let textWsUrl = 'ws://3.77.202.1:5147/ws/suggestions';
let textWsConfigSent = false;
let audioContext = null;
let processor = null;
let bufferedSamples = [];
let bufferedCount = 0;
const CHUNK_MS = 4000;
const TARGET_SAMPLE_RATE = 48000;

init();

async function init() {
  const stored = await browserApi.storage.local.get([
    STORAGE_KEYS.STATUS,
    STORAGE_KEYS.LAST_ERROR
  ]);
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
  openControlBtn?.addEventListener('click', openControlWindow);
  // Keep the popup alive by pinning timers; Chrome will still close on blur but this reduces GC sleeps.
  setInterval(() => chrome.runtime?.getPlatformInfo?.(() => {}), 20000);

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
    const stream = await requestSystemStream();
    await startRecording(stream);
    try {
      await startMicRecording();
    } catch (err) {
      console.warn('Mic start failed', err);
    }
    openTextWebSocket();
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
    if (!previewAudio || !previewMeta) return;
    previewAudio.src = payload.dataUrl;
    previewAudio.load();
    const kb = Math.round((payload.size || 0) / 1024);
    const time = new Date(payload.ts || Date.now()).toLocaleTimeString();
    previewMeta.textContent = `Last chunk: ${kb} KB · ${payload.mime || 'audio/wav'} · ${time}`;
  } catch (_err) {
    // ignore preview errors
  }
}

function updatePreviewMic(payload) {
  try {
    if (!previewAudioMic || !previewMetaMic) return;
    previewAudioMic.src = payload.dataUrl;
    previewAudioMic.load();
    const kb = Math.round((payload.size || 0) / 1024);
    const time = new Date(payload.ts || Date.now()).toLocaleTimeString();
    previewMetaMic.textContent = `Last mic chunk: ${kb} KB · ${payload.mime || 'audio/wav'} · ${time}`;
  } catch (_err) {
    // ignore preview errors
  }
}

async function requestSystemStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('System capture not supported in this browser');
  }
  return navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
}

async function startMicRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture not supported in this browser');
  }
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  micContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const source = micContext.createMediaStreamSource(micStream);
  micProcessor = micContext.createScriptProcessor(4096, 1, 1);
  micProcessor.onaudioprocess = onMicAudioProcess;
  source.connect(micProcessor);
  micProcessor.connect(micContext.destination);
  openMicWebSocket();
}

async function startRecording(stream) {
  captureStream = stream;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    throw new Error('No audio track in shared stream. Ensure "Share tab audio" is enabled in the picker.');
  }
  // Keep original stream alive; record only audio tracks.
  recorderStream = new MediaStream(audioTracks);

  // Stop if the shared tracks end (user stops sharing).
  captureStream.getTracks().forEach((t) => {
    t.onended = () => stopRecording('Capture ended');
  });

  // Pipe into AudioContext to capture PCM at TARGET_SAMPLE_RATE.
  audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(recorderStream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = onAudioProcess;
  source.connect(processor);
  processor.connect(audioContext.destination);

  openWebSocket();
  currentStatus = STATUS.LISTENING;
  lastError = '';
  renderStatus(currentStatus, lastError);
  safeSendStatus(currentStatus, '');
}

function stopRecording(reason = '') {
  try {
    if (processor) {
      processor.disconnect();
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
    }
    if (micProcessor) {
      micProcessor.disconnect();
    }
    if (micContext) {
      micContext.close().catch(() => {});
    }
  } catch (err) {
    console.warn('Stop recorder failed', err);
  } finally {
    cleanup(); // stop tracks but keep preview element intact
    currentStatus = STATUS.IDLE;
    lastError = reason || '';
    renderStatus(currentStatus, lastError);
    safeSendStatus(currentStatus, lastError);
    closeWebSocket();
    closeMicWebSocket();
    closeTextWebSocket();
    setRandomScore();
  }
}

function cleanup() {
  if (captureStream) {
    captureStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (_err) {
        // ignore
      }
    });
  }
  captureStream = null;
  if (recorderStream) {
    recorderStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (_err) {
        // ignore
      }
    });
  }
  recorderStream = null;
  mediaRecorder = null;
  processor = null;
  audioContext = null;
  bufferedSamples = [];
  bufferedCount = 0;
  if (micStream) {
    micStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (_err) {
        // ignore
      }
    });
  }
  micStream = null;
  micProcessor = null;
  micContext = null;
  micBufferedSamples = [];
  micBufferedCount = 0;
}

function onAudioProcess(event) {
  const input = event.inputBuffer.getChannelData(0);
  // Copy to avoid holding onto underlying buffer.
  bufferedSamples.push(new Float32Array(input));
  bufferedCount += input.length;

  const neededSamples = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000;
  if (bufferedCount >= neededSamples) {
    flushPcmChunk(neededSamples);
  }
}

function onMicAudioProcess(event) {
  const input = event.inputBuffer.getChannelData(0);
  micBufferedSamples.push(new Float32Array(input));
  micBufferedCount += input.length;
  const neededSamples = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000;
  if (micBufferedCount >= neededSamples) {
    flushMicPcmChunk(neededSamples);
  }
}

async function sendMockAdvice() {
  try {
    const tab = await getPageTab();
    if (!tab) {
      renderStatus(STATUS.ERROR, 'Open a normal http/https page tab first, then retry mock advice');
      return;
    }
    await ensureContentScript(tab.id);
    const captionText = captionInput?.value?.trim();
    await browserApi.tabs.sendMessage(tab.id, {
      type: MESSAGE_TYPES.ADVICE_CENTER,
      payload: { text: captionText || 'Mock advice: keep answers concise and listen actively.' }
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

async function getPageTab() {
  const candidates = [];
  candidates.push(...(await browserApi.tabs.query({ active: true, currentWindow: true })));
  candidates.push(...(await browserApi.tabs.query({ active: true, lastFocusedWindow: true })));
  if (lastPageTabId) {
    const lastTab = await browserApi.tabs.get(lastPageTabId).catch(() => null);
    if (lastTab) candidates.unshift(lastTab);
  }
  // Fallback: grab most recently active normal tab.
  const allTabs = await browserApi.tabs.query({});
  allTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  candidates.push(...allTabs);

  const page = candidates.find(
    (t) => t?.id && t.url && /^https?:/i.test(t.url) && !t.url.includes('chrome.google.com/webstore')
  );
  if (page?.id) {
    lastPageTabId = page.id;
  }
  return page || null;
}

function chooseMimeType() {
  return 'audio/wav';
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

function safeSendStatus(status, error) {
  // In MV3 the service worker may be asleep; ignore missing receiver errors.
  if (!browserApi?.runtime?.sendMessage) return;
  browserApi.runtime.sendMessage({ type: MESSAGE_TYPES.STATUS_UPDATE, payload: { status, error } }, () => {
    void browserApi.runtime.lastError;
  });
}

function onTextWsUrlChange() {
}

function openWebSocket() {
  closeWebSocket();
  if (!wsUrl) return;
  wsConfigSent = false;
  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      wsReady = true;
      renderStatus(currentStatus, lastError);
    };
    ws.onmessage = async (event) => {
      try {
        const text = await extractText(event.data);
        if (text) {
          const tab = await getPageTab();
          if (tab?.id) {
            await ensureContentScript(tab.id);
            await browserApi.tabs.sendMessage(tab.id, {
              type: MESSAGE_TYPES.ADVICE,
              payload: { text }
            });
          }
        }
      } catch (err) {
        console.warn('WS message handling failed', err);
      }
    };
    ws.onerror = (event) => {
      wsReady = false;
      lastError = `WS error (${wsUrl}): ${event?.message || 'unknown'}`;
      renderStatus(currentStatus, lastError);
    };
    ws.onclose = (event) => {
      wsReady = false;
      ws = null;
      wsConfigSent = false;
      const reason = event?.reason ? ` ${event.reason}` : '';
      lastError = lastError || `WS closed (${event?.code || ''}${reason})`;
      renderStatus(currentStatus, lastError);
    };
  } catch (err) {
    wsReady = false;
    lastError = `WS connect failed (${wsUrl}): ${err?.message || 'unknown'}`;
    renderStatus(currentStatus, lastError);
  }
}

function closeWebSocket() {
  if (ws) {
    try {
      ws.close();
    } catch (_err) {
      // ignore
    }
  }
  ws = null;
  wsReady = false;
  wsConfigSent = false;
}

function openControlWindow() {
  const url = browserApi.runtime.getURL('src/control/control.html');
  browserApi.windows?.create(
    {
      url,
      type: 'popup',
      width: 420,
      height: 680
    },
    () => void browserApi.runtime.lastError
  );
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

function flushPcmChunk(neededSamples) {
  const merged = new Float32Array(bufferedCount);
  let offset = 0;
  for (const chunk of bufferedSamples) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  bufferedSamples = [];
  bufferedCount = 0;

  const resampled =
    audioContext && audioContext.sampleRate !== TARGET_SAMPLE_RATE
      ? resampleBuffer(merged, audioContext.sampleRate, TARGET_SAMPLE_RATE)
      : merged;

  const trimmed = resampled.length > neededSamples ? resampled.subarray(0, neededSamples) : resampled;

  const pcmBuffer = floatTo16LE(trimmed);
  const wavBlob = pcmToWavBlob(pcmBuffer, TARGET_SAMPLE_RATE);

  updatePreview({
    dataUrl: URL.createObjectURL(wavBlob),
    size: wavBlob.size,
    mime: 'audio/wav',
    ts: Date.now()
  });

  if (wsReady && ws) {
    sendWsChunk(pcmBuffer.buffer);
  }
  if (micWsReady && micWs) {
    sendMicWsChunk(pcmBuffer.buffer);
  }
  if (textWsReady && textWs) {
    sendTextWsPreamble();
  }
}

function flushMicPcmChunk(neededSamples) {
  const merged = new Float32Array(micBufferedCount);
  let offset = 0;
  for (const chunk of micBufferedSamples) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  micBufferedSamples = [];
  micBufferedCount = 0;

  const resampled =
    micContext && micContext.sampleRate !== TARGET_SAMPLE_RATE
      ? resampleBuffer(merged, micContext.sampleRate, TARGET_SAMPLE_RATE)
      : merged;

  const trimmed = resampled.length > neededSamples ? resampled.subarray(0, neededSamples) : resampled;
  const pcmBuffer = floatTo16LE(trimmed);

  const wavBlob = pcmToWavBlob(pcmBuffer, TARGET_SAMPLE_RATE);
  updatePreviewMic({
    dataUrl: URL.createObjectURL(wavBlob),
    size: wavBlob.size,
    mime: 'audio/wav',
    ts: Date.now()
  });

  if (micWsReady && micWs) {
    sendMicWsChunk(pcmBuffer.buffer);
  }
}

function resampleBuffer(input, inputRate, targetRate) {
  if (inputRate === targetRate) return input;
  const ratio = inputRate / targetRate;
  const newLength = Math.floor(input.length / ratio);
  const output = new Float32Array(newLength);
  for (let i = 0; i < newLength; i += 1) {
    const idx = i * ratio;
    const idxFloor = Math.floor(idx);
    const idxCeil = Math.min(input.length - 1, idxFloor + 1);
    const frac = idx - idxFloor;
    output[i] = input[idxFloor] * (1 - frac) + input[idxCeil] * frac;
  }
  return output;
}

function floatTo16LE(float32Array) {
  const output = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function pcmToWavBlob(int16Array, sampleRate) {
  const buffer = new ArrayBuffer(44 + int16Array.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + int16Array.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, int16Array.length * 2, true);

  let offset = 44;
  for (let i = 0; i < int16Array.length; i += 1, offset += 2) {
    view.setInt16(offset, int16Array[i], true);
  }

  return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function setRandomScore() {
  if (!scoreField) return;
  const value = Math.floor(Math.random() * 101);
  scoreField.value = `Score: ${value}`;
}

function sendWsChunk(buffer) {
  try {
    if (!wsReady || !ws) return;
    ws.send(buffer);
  } catch (err) {
    wsReady = false;
    lastError = err?.message || 'WebSocket send failed';
    renderStatus(currentStatus, lastError);
  }
}

function sendMicWsChunk(buffer) {
  try {
    if (!micWsReady || !micWs) return;
    micWs.send(buffer);
  } catch (err) {
    micWsReady = false;
    lastError = err?.message || 'Mic WebSocket send failed';
    renderStatus(currentStatus, lastError);
  }
}

function sendTextWsPreamble() {
  try {
    if (!textWsReady || !textWs || textWsConfigSent) return;
    textWs.send(JSON.stringify({ type: 'text-listen', note: 'client-ready' }));
    textWsConfigSent = true;
  } catch (err) {
    textWsReady = false;
    lastError = err?.message || 'Text WebSocket send failed';
    renderStatus(currentStatus, lastError);
  }
}

function openMicWebSocket() {
  closeMicWebSocket();
  if (!micWsUrl) return;
  micWsConfigSent = false;
  try {
    micWs = new WebSocket(micWsUrl);
    micWs.binaryType = 'arraybuffer';
    micWs.onopen = () => {
      micWsReady = true;
      renderStatus(currentStatus, lastError);
    };
    micWs.onmessage = async (event) => {
      try {
        const text = await extractText(event.data);
        if (text) {
          const tab = await getPageTab();
          if (tab?.id) {
            await ensureContentScript(tab.id);
            await browserApi.tabs.sendMessage(tab.id, {
              type: MESSAGE_TYPES.ADVICE_LEFT,
              payload: { text }
            });
          }
        }
      } catch (err) {
        console.warn('Mic WS message handling failed', err);
      }
    };
    micWs.onerror = (event) => {
      micWsReady = false;
      lastError = `Mic WS error (${micWsUrl}): ${event?.message || 'unknown'}`;
      renderStatus(currentStatus, lastError);
    };
    micWs.onclose = (event) => {
      micWsReady = false;
      micWs = null;
      micWsConfigSent = false;
      const reason = event?.reason ? ` ${event.reason}` : '';
      lastError = lastError || `Mic WS closed (${event?.code || ''}${reason})`;
      renderStatus(currentStatus, lastError);
    };
  } catch (err) {
    micWsReady = false;
    lastError = `Mic WS connect failed (${micWsUrl}): ${err?.message || 'unknown'}`;
    renderStatus(currentStatus, lastError);
  }
}

function closeMicWebSocket() {
  if (micWs) {
    try {
      micWs.close();
    } catch (_err) {
      // ignore
    }
  }
  micWs = null;
  micWsReady = false;
  micWsConfigSent = false;
}

function openTextWebSocket() {
  closeTextWebSocket();
  if (!textWsUrl) return;
  textWsConfigSent = false;
  try {
    textWs = new WebSocket(textWsUrl);
    textWs.binaryType = 'arraybuffer';
    textWs.onopen = () => {
      textWsReady = true;
      sendTextWsPreamble();
      renderStatus(currentStatus, lastError);
    };
    textWs.onmessage = async (event) => {
      try {
        const text = await extractText(event.data);
        if (text) {
          const tab = await getPageTab();
          if (tab?.id) {
            await ensureContentScript(tab.id);
            await browserApi.tabs.sendMessage(tab.id, {
              type: MESSAGE_TYPES.ADVICE_CENTER,
              payload: { text }
            });
          }
        }
      } catch (err) {
        console.warn('Text WS message handling failed', err);
      }
    };
    textWs.onerror = (event) => {
      textWsReady = false;
      lastError = `Text WS error (${textWsUrl}): ${event?.message || 'unknown'}`;
      renderStatus(currentStatus, lastError);
    };
    textWs.onclose = (event) => {
      textWsReady = false;
      textWs = null;
      textWsConfigSent = false;
      const reason = event?.reason ? ` ${event.reason}` : '';
      lastError = lastError || `Text WS closed (${event?.code || ''}${reason})`;
      renderStatus(currentStatus, lastError);
    };
  } catch (err) {
    textWsReady = false;
    lastError = `Text WS connect failed (${textWsUrl}): ${err?.message || 'unknown'}`;
    renderStatus(currentStatus, lastError);
  }
}

function closeTextWebSocket() {
  if (textWs) {
    try {
      textWs.close();
    } catch (_err) {
      // ignore
    }
  }
  textWs = null;
  textWsReady = false;
  textWsConfigSent = false;
}
