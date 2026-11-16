// loading.js — tiny loading screen helpers
export function startLoading() {
  const el = document.getElementById('loading');
  if (el) el.classList.remove('hidden');
}

export function setProgress(p, label = '') {
  const bar = document.getElementById('loading-bar');
  const txt = document.getElementById('loading-label');
  if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  if (txt && label) txt.textContent = label;
}

export function hideLoading() {
  const el = document.getElementById('loading');
  if (el) el.classList.add('hidden');
}
