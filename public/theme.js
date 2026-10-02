// ---- Lucide icons ----
// The lucide script (loaded via CDN in each page's <head>) turns any
// <i data-lucide="name"> into an inline SVG when createIcons() runs. Call
// refreshIcons() again after injecting new HTML via innerHTML, since only
// icons present in the DOM at call time get converted.
function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}
document.addEventListener('DOMContentLoaded', refreshIcons);

// ---- Dark mode ----
const Theme = {
  key: 'edxka_theme',
  init() {
    const saved = localStorage.getItem(this.key) || 'light';
    document.documentElement.setAttribute('data-theme', saved);
  },
  toggle() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(this.key, next);
    return next;
  },
  current() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  },
};
Theme.init();

function mountThemeToggle(el) {
  if (!el) return;
  el.textContent = Theme.current() === 'dark' ? '☀️' : '🌙';
  el.addEventListener('click', () => {
    const next = Theme.toggle();
    el.textContent = next === 'dark' ? '☀️' : '🌙';
  });
}

// ---- Confetti (plain canvas, no external libraries/network calls) ----
function fireConfetti(count = 80) {
  const colors = ['#FF6A3D', '#1FAE8E', '#FFD166', '#6E4FA8', '#4DB6E0'];
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.animationDuration = 2 + Math.random() * 1.5 + 's';
    el.style.animationDelay = Math.random() * 0.3 + 's';
    el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
}

// ---- Tiny sound effects via WebAudio (no audio files, no network) ----
const Sound = {
  ctx: null,
  ensureCtx() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    return this.ctx;
  },
  tone(freq, duration, type = 'sine', gain = 0.08, delay = 0) {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(ctx.destination);
    const start = ctx.currentTime + delay;
    osc.start(start);
    g.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.stop(start + duration);
  },
  correct() { this.tone(660, 0.12); this.tone(880, 0.16, 'sine', 0.08, 0.08); },
  incorrect() { this.tone(180, 0.25, 'sawtooth', 0.06); },
  start() { this.tone(440, 0.1); this.tone(550, 0.12, 'sine', 0.07, 0.1); this.tone(660, 0.14, 'sine', 0.07, 0.2); },
  finish() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.2, 'sine', 0.07, i * 0.12)); },
};
