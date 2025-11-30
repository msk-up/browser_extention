const captureStateEl = document.getElementById("capture-state");
const captureSourceEl = document.getElementById("capture-source");
const wsStateEl = document.getElementById("ws-state");
const levelFillEl = document.getElementById("level-fill");
const mockCheckbox = document.getElementById("mock-mode");
const debugText = document.getElementById("debug-text");
let tabCapture = {
  stream: null,
  ctx: null,
  processor: null
};

document.getElementById("start-mic").addEventListener("click", async () => {
  try {
    const resp = await browser.runtime.sendMessage({ type: "start-capture", source: "mic" });
    showResult(resp);
  } catch (err) {
    setDebug(`start-mic failed: ${err?.message || err}`);
  }
});

document.getElementById("start-tab").addEventListener("click", async () => {
  // getDisplayMedia may prompt for screen share with audio; user gesture is this click.
  try {
    await startTabCaptureInPopup();
  } catch (err) {
    const message = err?.message || String(err);
    setDebug(`start-tab failed: ${message}`);
    if (message.toLowerCase().includes("not allowed")) {
      setDebug(
        "start-tab blocked by Firefox in this context. Mic capture is reliable; tab audio capture may be unavailable in this build."
      );
    }
  }
});

document.getElementById("stop").addEventListener("click", async () => {
  try {
    stopTabCaptureInPopup();
    const resp = await browser.runtime.sendMessage({ type: "stop-capture" });
    showResult(resp);
  } catch (err) {
    setDebug(`stop failed: ${err?.message || err}`);
  }
});

document.getElementById("send-fake").addEventListener("click", () => {
  const text = document.getElementById("fake-text").value || "Try asking about their budget";
  browser.runtime.sendMessage({ type: "send-fake-text", text });
});

mockCheckbox.addEventListener("change", () => {
  browser.runtime.sendMessage({ type: "set-config", config: { mockMode: mockCheckbox.checked } });
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "capture-status") {
    captureStateEl.textContent = message.capturing ? "capturing" : "stopped";
    captureSourceEl.textContent = message.sourceType || "-";
  } else if (message.type === "ws-status") {
    wsStateEl.textContent = message.status;
  } else if (message.type === "audio-level") {
    const pct = Math.min(100, Math.floor((message.level || 0) * 140));
    levelFillEl.style.width = `${pct}%`;
  } else if (message.type === "capture-error") {
    captureStateEl.textContent = `error: ${message.error}`;
    setDebug(`capture-error: ${message.error}`);
  }
});

function showResult(resp) {
  if (!resp) return;
  if (resp.error) {
    captureStateEl.textContent = `error: ${resp.error}`;
  }
  if (resp.status) {
    captureStateEl.textContent = resp.status;
  }
  if (resp.sourceType) {
    captureSourceEl.textContent = resp.sourceType;
  }
  setDebug(resp.error ? `error: ${resp.error}` : `status: ${resp.status || "ok"}`);
}

async function startTabCaptureInPopup() {
  stopTabCaptureInPopup();
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  stream.getVideoTracks().forEach((t) => t.stop()); // we only need audio
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    let rms = 0;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      rms += s * s;
    }
    rms = Math.sqrt(rms / input.length);
    const buf = pcm.buffer;
    browser.runtime.sendMessage({ type: "pcm-chunk", data: buf }, [buf]).catch(() => {});
    browser.runtime
      .sendMessage({ type: "pcm-config", sampleRate: ctx.sampleRate, source: "tab" })
      .catch(() => {});
    const pct = Math.min(100, Math.floor(rms * 140));
    levelFillEl.style.width = `${pct}%`;
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  tabCapture = { stream, ctx, processor };
  captureStateEl.textContent = "capturing";
  captureSourceEl.textContent = "tab";
  setDebug("status: capturing tab audio (popup pipeline)");
  browser.runtime.sendMessage({ type: "ensure-ws" }).catch(() => {});
}

function stopTabCaptureInPopup() {
  if (tabCapture.processor) {
    try {
      tabCapture.processor.disconnect();
    } catch (_) {}
  }
  if (tabCapture.ctx) {
    try {
      tabCapture.ctx.close();
    } catch (_) {}
  }
  if (tabCapture.stream) {
    tabCapture.stream.getTracks().forEach((t) => t.stop());
  }
  tabCapture = { stream: null, ctx: null, processor: null };
}

function setDebug(text) {
  debugText.textContent = text;
}

async function init() {
  const status = await browser.runtime.sendMessage({ type: "request-status" }).catch(() => null);
  if (status) {
    captureStateEl.textContent = status.capturing ? "capturing" : "stopped";
    captureSourceEl.textContent = status.sourceType || "-";
    wsStateEl.textContent =
      typeof status.wsStatus === "number"
        ? { 0: "connecting", 1: "open", 2: "closing", 3: "closed" }[status.wsStatus] ||
          String(status.wsStatus)
        : status.wsStatus || "closed";
    mockCheckbox.checked = !!status.config?.mockMode;
  }
  setDebug("ready");
}

init();
