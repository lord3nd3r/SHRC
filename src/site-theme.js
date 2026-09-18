export const THEME_IDS = ['phosphor', 'amber', 'ice', 'slate', 'paper'];

export function currentTheme() {
  return document.body.dataset.theme || 'phosphor';
}

export function applySiteTheme(name) {
  const id = THEME_IDS.includes(name) ? name : 'phosphor';
  document.body.dataset.theme = id;
  document.documentElement.dataset.theme = id;
  document.documentElement.style.colorScheme = id === 'paper' ? 'light' : 'dark';
  try { localStorage.setItem('shrc-theme', id); } catch {}
  const sel = document.getElementById('theme-select');
  if (sel && sel.value !== id) sel.value = id;
}

export function applyCrt(on) {
  document.body.classList.toggle('crt-active', on);
  const btn = document.getElementById('crt-toggle-btn');
  if (btn) {
    btn.textContent = on ? 'crt on' : 'crt off';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  try { localStorage.setItem('shrc-crt', on ? '1' : '0'); } catch {}
}

export function applyFont(px) {
  const n = Math.min(22, Math.max(11, parseInt(px, 10) || 13));
  try { localStorage.setItem('shrc-font', String(n)); } catch {}
  const sel = document.getElementById('font-select');
  if (sel) sel.value = String(n);
  return n;
}

export function initAppearance() {
  let theme = 'phosphor';
  let crt = true;
  try {
    theme = localStorage.getItem('shrc-theme') || 'phosphor';
    crt = localStorage.getItem('shrc-crt') !== '0';
  } catch {}
  applySiteTheme(theme);
  applyCrt(crt);

  document.getElementById('theme-select')?.addEventListener('change', (e) => {
    applySiteTheme(e.target.value);
  });
  document.getElementById('crt-toggle-btn')?.addEventListener('click', () => {
    applyCrt(!document.body.classList.contains('crt-active'));
  });

  const fontSel = document.getElementById('font-select');
  if (fontSel) {
    let fs = '13';
    try { fs = localStorage.getItem('shrc-font') || '13'; } catch {}
    fontSel.value = fs;
    fontSel.addEventListener('change', () => applyFont(fontSel.value));
  }
  const clockSel = document.getElementById('clock-select');
  if (clockSel) {
    let c = '24';
    try { c = localStorage.getItem('shrc-clock') || '24'; } catch {}
    clockSel.value = c;
    clockSel.addEventListener('change', () => {
      try { localStorage.setItem('shrc-clock', clockSel.value); } catch {}
    });
  }
  const beepEl = document.getElementById('beep-toggle');
  if (beepEl) {
    let on = false;
    try { on = localStorage.getItem('shrc-beep') === '1'; } catch {}
    beepEl.checked = on;
    beepEl.addEventListener('change', () => {
      try { localStorage.setItem('shrc-beep', beepEl.checked ? '1' : '0'); } catch {}
    });
  }
}
