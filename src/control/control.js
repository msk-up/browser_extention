import '../popup/popup.js';
import { MESSAGE_TYPES, browserApi } from '../common/messaging.js';

const tipsContainer = document.getElementById('tips-content');
const subtitlesContainer = document.getElementById('subtitles-content');

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initControl);
} else {
  initControl();
}

function initControl() {
  // Listen for advice/tips messages (left side)
  browserApi.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE_TYPES.ADVICE || message?.type === MESSAGE_TYPES.ADVICE_LEFT) {
      const text = message.payload?.text || 'New tip received';
      addTip(text);
    }
    if (message?.type === MESSAGE_TYPES.ADVICE_CENTER) {
      const text = message.payload?.text || 'New subtitle received';
      addSubtitle(text);
    }
  });
}

function addTip(text) {
  if (!tipsContainer) return;
  const tipItem = document.createElement('div');
  tipItem.className = 'tip-item';
  tipItem.textContent = text;
  tipsContainer.appendChild(tipItem);
  // Auto-scroll to bottom
  const container = tipsContainer.parentElement;
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
  // Limit to last 50 tips
  while (tipsContainer.children.length > 50) {
    tipsContainer.removeChild(tipsContainer.firstChild);
  }
}

function addSubtitle(text) {
  if (!subtitlesContainer) return;
  const subtitleItem = document.createElement('div');
  subtitleItem.className = 'subtitle-item';
  subtitleItem.textContent = text;
  subtitlesContainer.appendChild(subtitleItem);
  // Auto-scroll to bottom
  const container = subtitlesContainer.parentElement;
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
  // Limit to last 50 subtitles
  while (subtitlesContainer.children.length > 50) {
    subtitlesContainer.removeChild(subtitlesContainer.firstChild);
  }
}
