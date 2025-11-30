(() => {
  if (window.__MC_CONTENT_LOADED__) {
    return;
  }
  window.__MC_CONTENT_LOADED__ = true;

  const MESSAGE_TYPES = {
    ADVICE: 'ADVICE',
    ADVICE_LEFT: 'ADVICE_LEFT',
    ADVICE_CENTER: 'ADVICE_CENTER'
  };

  let hideTimer = null;
  let hideTimerLeft = null;
  let hideTimerCenter = null;
  const DISPLAY_DURATION = 12000;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE_TYPES.ADVICE) {
      const text = message.payload?.text || 'New advice received';
      showAdvice(text);
    }
    if (message?.type === MESSAGE_TYPES.ADVICE_LEFT) {
      const text = message.payload?.text || 'New advice received';
      showAdviceLeft(text);
    }
    if (message?.type === MESSAGE_TYPES.ADVICE_CENTER) {
      const text = message.payload?.text || 'New advice received';
      showAdviceCenter(text);
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

  function showAdviceLeft(text) {
    const container = ensureContainerLeft();
    container.textContent = text;
    container.classList.add('mc-visible');

    if (hideTimerLeft) {
      clearTimeout(hideTimerLeft);
    }
    hideTimerLeft = setTimeout(() => {
      container.classList.remove('mc-visible');
    }, DISPLAY_DURATION);
  }

  function showAdviceCenter(text) {
    const container = ensureContainerCenter();
    container.textContent = text;
    container.classList.add('mc-visible');

    if (hideTimerCenter) {
      clearTimeout(hideTimerCenter);
    }
    hideTimerCenter = setTimeout(() => {
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

    injectStyle();
    return container;
  }

  function ensureContainerLeft() {
    let container = document.getElementById('mc-advice-overlay-left');
    if (container) return container;

    container = document.createElement('div');
    container.id = 'mc-advice-overlay-left';
    container.className = 'mc-advice-overlay';
    container.textContent = 'Advice will appear here';
    document.body.appendChild(container);
    injectStyle();
    return container;
  }

  function ensureContainerCenter() {
    let container = document.getElementById('mc-advice-overlay-center');
    if (container) return container;

    container = document.createElement('div');
    container.id = 'mc-advice-overlay-center';
    container.className = 'mc-advice-overlay';
    container.textContent = 'Advice will appear here';
    document.body.appendChild(container);
    injectStyle();
    return container;
  }

  function injectStyle() {
    if (document.getElementById('mc-advice-style')) return;
    const style = document.createElement('style');
    style.id = 'mc-advice-style';
    style.textContent = `
      #mc-advice-overlay,
      #mc-advice-overlay-left,
      #mc-advice-overlay-center {
        position: fixed;
        bottom: 20px;
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
      #mc-advice-overlay { right: 20px; }
      #mc-advice-overlay-left { left: 20px; }
      #mc-advice-overlay-center { left: 50%; transform: translate(-50%, 10px); }
      #mc-advice-overlay.mc-visible,
      #mc-advice-overlay-left.mc-visible,
      #mc-advice-overlay-center.mc-visible {
        opacity: 0.96;
        transform: translateY(0);
      }
    `;
    document.head.appendChild(style);
  }
})();
