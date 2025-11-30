(() => {
(() => {
  if (window.__MC_CONTENT_LOADED__) {
    // Already injected; avoid redeclaring constants/listeners.
    return;
  }
  window.__MC_CONTENT_LOADED__ = true;

  const MESSAGE_TYPES = {
    ADVICE: 'ADVICE'
  };

  let hideTimer = null;
  const DISPLAY_DURATION = 12000;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE_TYPES.ADVICE) {
      const text = message.payload?.text || 'New advice received';
      showAdvice(text);
    }
  });

  function showAdvice(text) {
    const container = ensureContainer();
    container.textContent = text;
    container.classList.add('mc-visible');

    if (hideTimer) {
      clearTimeout(hideTimer);
    }
    hideTimer = setTimeout(() => {
      container.classList.remove('mc-visible');
    }, DISPLAY_DURATION);
  }

  function ensureContainer() {
    let container = document.getElementById('mc-advice-overlay');
    if (container) return container;

    container = document.createElement('div');
    container.id = 'mc-advice-overlay';
    container.className = 'mc-advice-overlay';
    container.textContent = 'Advice will appear here';
    document.body.appendChild(container);

    const style = document.createElement('style');
    style.textContent = `
      #mc-advice-overlay {
        position: fixed;
        bottom: 20px;
        right: 20px;
        max-width: 320px;
        padding: 12px 14px;
        border-radius: 10px;
        background: #111827;
        color: #f9fafb;
        font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
        font-size: 14px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
        transition: opacity 0.25s ease, transform 0.25s ease;
        z-index: 2147483646;
      }

      #mc-advice-overlay.mc-visible {
        opacity: 0.96;
        transform: translateY(0);
      }
    `;
    document.head.appendChild(style);

    return container;
  }
})();
})();
