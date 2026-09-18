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
}
