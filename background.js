// Background script: handles audio capture, WebSocket streaming, mock mode, and messaging.

const DEFAULT_CONFIG = {
  wsUrl: "wss://localhost:8080/ws", // Placeholder; override in options.
  autoConnect: true,
  autoShowSnackbar: true,
  mockMode: false
};

let config = { ...DEFAULT_CONFIG };
let ws = null;
let reconnectTimer = null;
let audioContext = null;
let processor = null;
let mediaStream = null;
let capturing = false;
let sourceType = null; // "mic" or "tab"
let mockInterval = null;
let externalSource = null; // { sampleRate, source }

// Helpers
const log = (...args) => console.log("[NegotiationAssistant]", ...args);

async function loadConfig() {
  const stored = await browser.storage.sync.get(DEFAULT_CONFIG);
  config = { ...DEFAULT_CONFIG, ...stored };
  return config;
}

function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  return browser.storage.sync.set(config);
}

async function sendToAllTabs(message) {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map((tab) => browser.tabs.sendMessage(tab.id, message).catch(() => {}))
  );
}

function broadcastRuntime(message) {
  browser.runtime.sendMessage(message).catch(() => {});
}

// Audio capture
async function startAudioCapture(kind = "mic") {
  await loadConfig();
  if (capturing) {
    return { status: "already_capturing" };
  }

  try {
    const constraints =
      kind === "tab"
        ? { audio: true, video: true } // Firefox requires video with display capture prompts.
        : { audio: true, video: false };

    // For tab/system audio we must call getDisplayMedia; it requires a user gesture.
    // If the call is not triggered by the popup click, Firefox will reject without prompt.
    if (kind === "tab") {
      if (!navigator.mediaDevices.getDisplayMedia) {
        throw new Error("getDisplayMedia not supported");
      }
      mediaStream = await navigator.mediaDevices.getDisplayMedia(constraints);
    } else {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    sourceType = kind === "tab" && navigator.mediaDevices.getDisplayMedia ? "tab" : "mic";
    // Drop video tracks if present (we only need audio).
    if (sourceType === "tab") {
      mediaStream.getVideoTracks().forEach((t) => t.stop());
    }
    setupAudioPipeline();
    capturing = true;
    broadcastRuntime({ type: "capture-status", capturing: true, sourceType });
    log("Capture started:", sourceType);

    if (config.autoConnect && !config.mockMode) {
      connectWebSocket();
    } else if (config.mockMode) {
      enableMockMode();
    }
    return { status: "capturing", sourceType };
  } catch (err) {
    log("Capture error", err);
    const message =
      err?.message ||
      (err?.name === "NotAllowedError"
        ? "Permission denied. Check mic/screen permission."
        : "Failed to start capture");
    broadcastRuntime({ type: "capture-error", error: message });
    return { status: "error", error: message };
  }
}

function setupAudioPipeline() {
  audioContext = new AudioContext();
  const sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const bufferSize = 4096;
  processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
  processor.onaudioprocess = handleAudioProcess;
  sourceNode.connect(processor);
  processor.connect(audioContext.destination); // Keeps processor running.
}

function handleAudioProcess(event) {
  const input = event.inputBuffer.getChannelData(0);
  const pcmBuffer = new Int16Array(input.length);
  let rms = 0;
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    pcmBuffer[i] = val;
    rms += s * s;
  }
  rms = Math.sqrt(rms / input.length);
  broadcastRuntime({ type: "audio-level", level: rms });

  if (config.mockMode) {
    return;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(pcmBuffer.buffer);
  }
}

function stopAudioCapture() {
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  capturing = false;
  sourceType = null;
  broadcastRuntime({ type: "capture-status", capturing: false });
  log("Capture stopped");
}

// WebSocket
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (!config.wsUrl) {
    log("No WebSocket URL configured");
    return;
  }

  log("Connecting WebSocket to", config.wsUrl);
  ws = new WebSocket(config.wsUrl);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    log("WebSocket open");
    broadcastRuntime({ type: "ws-status", status: "open" });
    sendConfigFrame();
  });

  ws.addEventListener("message", (event) => {
    handleWsMessage(event.data);
  });

  ws.addEventListener("close", () => {
    log("WebSocket closed");
    broadcastRuntime({ type: "ws-status", status: "closed" });
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", (err) => {
    log("WebSocket error", err);
    broadcastRuntime({ type: "ws-status", status: "error" });
    ws?.close();
  });
}

function scheduleReconnect() {
  if (!config.autoConnect || config.mockMode) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 2000);
}

function sendConfigFrame() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const rate = externalSource?.sampleRate || audioContext?.sampleRate;
  const source = externalSource?.source || sourceType || "mic";
  if (!rate) return;
  ws.send(
    JSON.stringify({
      type: "config",
      format: "pcm_s16le",
      sampleRate: rate,
      source
    })
  );
}

function handleWsMessage(data) {
  let payload = null;
  if (typeof data === "string") {
    try {
      payload = JSON.parse(data);
    } catch {
      payload = { type: "text", text: data };
    }
  } else {
    return;
  }

  if (payload.type === "suggestion" || payload.type === "text") {
    sendToAllTabs({ type: "snackbar-text", text: payload.text || "" });
  } else if (payload.type === "words") {
    sendToAllTabs({ type: "snackbar-append", text: payload.text || "" });
  }
}

// Mock mode
function enableMockMode() {
  disableMockMode();
  log("Mock mode enabled");
  mockInterval = setInterval(() => {
    const samples = [
      "Ask about budget",
      "Confirm decision maker",
      "Clarify timeline",
      "Check for blockers",
      "Offer next steps"
    ];
    const text = samples[Math.floor(Math.random() * samples.length)];
    sendToAllTabs({ type: "snackbar-text", text: text + " (mock)" });
  }, 5000);
}

function disableMockMode() {
  if (mockInterval) {
    clearInterval(mockInterval);
    mockInterval = null;
  }
}

// Messaging from popup/options/content scripts
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "start-capture") {
    return startAudioCapture(message.source || "mic");
  }
  if (message?.type === "stop-capture") {
    stopAudioCapture();
    return Promise.resolve({ status: "stopped" });
  }
  if (message?.type === "send-fake-text") {
    sendToAllTabs({ type: "snackbar-text", text: message.text || "" });
  }
  if (message?.type === "request-status") {
    return Promise.resolve({
      capturing,
      sourceType,
      wsStatus: ws ? ws.readyState : "closed",
      config
    });
  }
  if (message?.type === "set-config") {
    saveConfig(message.config || {});
    if (message.config?.mockMode) {
      enableMockMode();
    } else {
      disableMockMode();
    }
  }
  if (message?.type === "pcm-config") {
    externalSource = { sampleRate: message.sampleRate, source: message.source || "tab" };
    sendConfigFrame();
  }
  if (message?.type === "pcm-chunk" && message.data instanceof ArrayBuffer) {
    if (config.mockMode) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
    ws?.send(message.data);
  }
  if (message?.type === "ensure-ws") {
    connectWebSocket();
  }
  return undefined;
});

// Init
loadConfig().then(() => {
  if (config.mockMode) {
    enableMockMode();
  }
});
