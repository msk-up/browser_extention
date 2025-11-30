// Content script: injects bottom snackbar overlay and displays incoming text.

const BAR_ID = "negotiation-assistant-snackbar";
const TEXT_ID = "negotiation-assistant-text";
const STATUS_ID = "negotiation-assistant-status";
const SHARE_ID = "negotiation-assistant-share";
let tabCapture = { stream: null, ctx: null, processor: null };

function ensureBar() {
  let bar = document.getElementById(BAR_ID);
  if (bar) return bar;

  bar = document.createElement("div");
  bar.id = BAR_ID;

  const textEl = document.createElement("div");
  textEl.id = TEXT_ID;
  textEl.textContent = "Negotiation assistant ready.";

  const statusEl = document.createElement("div");
  statusEl.id = STATUS_ID;
  statusEl.textContent = "Idle";

  const shareBtn = document.createElement("button");
  shareBtn.id = SHARE_ID;
  shareBtn.textContent = "Share tab audio";
  shareBtn.title = "Capture this tab/screen audio (Firefox prompt required)";
  shareBtn.addEventListener("click", () => {
    startTabCaptureInPage().catch((err) => {
      updateStatus(
        `Tab audio failed: ${err?.message || err || "not allowed in this context"}`
      );
    });
  });

  const buttons = document.createElement("div");
  buttons.className = "negotiation-assistant-buttons";

  const minimize = document.createElement("button");
  minimize.textContent = "−";
  minimize.title = "Minimize";
  minimize.addEventListener("click", () => bar.classList.toggle("collapsed"));

  const close = document.createElement("button");
  close.textContent = "×";
  close.title = "Close";
  close.addEventListener("click", () => bar.remove());

  buttons.append(shareBtn, minimize, close);
  bar.append(textEl, statusEl, buttons);
  document.documentElement.appendChild(bar);
  return bar;
}

function updateText(text) {
  ensureBar();
  const el = document.getElementById(TEXT_ID);
  if (el) el.textContent = text;
}

function appendText(text) {
  ensureBar();
  const el = document.getElementById(TEXT_ID);
  if (el) el.textContent = (el.textContent + " " + text).trim();
}

function updateStatus(text) {
  ensureBar();
  const el = document.getElementById(STATUS_ID);
  if (el) el.textContent = text;
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "snackbar-text") {
    updateText(message.text || "");
  } else if (message.type === "snackbar-append") {
    appendText(message.text || "");
  } else if (message.type === "snackbar-status") {
    updateStatus(message.text || "");
  }
});

// Start with the bar present so user knows it's available.
ensureBar();

async function startTabCaptureInPage() {
  stopTabCaptureInPage();
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const buf = pcm.buffer;
    browser.runtime.sendMessage({ type: "pcm-chunk", data: buf }, [buf]).catch(() => {});
    browser.runtime
      .sendMessage({ type: "pcm-config", sampleRate: ctx.sampleRate, source: "tab" })
      .catch(() => {});
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  tabCapture = { stream, ctx, processor };
  updateStatus("Capturing tab audio (page)");
  browser.runtime.sendMessage({ type: "ensure-ws" }).catch(() => {});
}

function stopTabCaptureInPage() {
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
