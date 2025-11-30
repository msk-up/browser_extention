const defaults = {
  wsUrl: "wss://localhost:8080/ws",
  autoConnect: true,
  autoShowSnackbar: true,
  mockMode: false
};

const wsInput = document.getElementById("ws-url");
const autoConnect = document.getElementById("auto-connect");
const autoSnackbar = document.getElementById("auto-snackbar");
const mockMode = document.getElementById("mock-mode");
const statusEl = document.getElementById("status");

async function load() {
  const stored = await browser.storage.sync.get(defaults);
  wsInput.value = stored.wsUrl || defaults.wsUrl;
  autoConnect.checked = stored.autoConnect ?? defaults.autoConnect;
  autoSnackbar.checked = stored.autoShowSnackbar ?? defaults.autoShowSnackbar;
  mockMode.checked = stored.mockMode ?? defaults.mockMode;
}

async function save(event) {
  event.preventDefault();
  const cfg = {
    wsUrl: wsInput.value || defaults.wsUrl,
    autoConnect: autoConnect.checked,
    autoShowSnackbar: autoSnackbar.checked,
    mockMode: mockMode.checked
  };
  await browser.storage.sync.set(cfg);
  await browser.runtime.sendMessage({ type: "set-config", config: cfg }).catch(() => {});
  statusEl.textContent = "Saved";
  setTimeout(() => (statusEl.textContent = ""), 1500);
}

document.getElementById("options-form").addEventListener("submit", save);
load();
