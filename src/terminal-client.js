const THEME_CRT = {
  background: '#020805',
  foreground: '#39ff6a',
  cursor: '#39ff6a',
  cursorAccent: '#020805',
  selectionBackground: '#1f8a3a',
  black: '#020805',
  red: '#ff5a5a',
  green: '#39ff6a',
  yellow: '#d4ff7a',
  blue: '#7dffd4',
  magenta: '#c4ff90',
  cyan: '#7dffd4',
  white: '#e8ffe8',
  brightBlack: '#4d8a5c',
  brightRed: '#ff8080',
  brightGreen: '#6dff90',
  brightYellow: '#f0ffb0',
  brightBlue: '#b0ffe8',
  brightMagenta: '#dcffb8',
  brightCyan: '#b8fff0',
  brightWhite: '#ffffff'
};

const THEME_SHARP = {
  background: '#020805',
  foreground: '#b6f5c3',
  cursor: '#39ff6a',
  cursorAccent: '#020805',
  selectionBackground: '#163d22',
  black: '#020805',
  red: '#ff6b6b',
  green: '#39ff6a',
  yellow: '#d4ff7a',
  blue: '#7dffd4',
  magenta: '#c4ff90',
  cyan: '#7dffd4',
  white: '#e8ffe8',
  brightBlack: '#4d8a5c',
  brightRed: '#ff8a8a',
  brightGreen: '#6dff90',
  brightYellow: '#f0ffb0',
  brightBlue: '#b0ffe8',
  brightMagenta: '#dcffb8',
  brightCyan: '#b8fff0',
  brightWhite: '#f5fff5'
};

export function initTerminalClient(containerId, closeBtnId) {
  const container = document.getElementById(containerId);
  const modal = document.getElementById('terminal-modal');
  const win = document.getElementById('terminal-window');
  const closeBtn = document.getElementById(closeBtnId);
  const maxBtn = document.getElementById('max-terminal-btn');
  if (!container) return;

  let socket = null;
  let term = null;
  let fitAddon = null;
  let started = false;

  function crtOn() {
    return document.body.classList.contains('crt-active');
  }

  function applyTheme() {
    if (!term) return;
    term.options.theme = crtOn() ? THEME_CRT : THEME_SHARP;
  }

  function size() {
    if (term && fitAddon) {
      try { fitAddon.fit(); } catch {}
    }
    return { cols: term?.cols || 90, rows: term?.rows || 30 };
  }

  function send(obj) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
  }

  function emitSize() {
    send({ op: 'resize', ...size() });
  }

  function setMax(on) {
    win?.classList.toggle('max', on);
    modal?.classList.toggle('maxed', on);
    if (maxBtn) maxBtn.textContent = on ? 'restore' : 'max';
    try { localStorage.setItem('shrc-tty-max', on ? '1' : '0'); } catch {}
    requestAnimationFrame(() => {
      emitSize();
      term?.focus();
    });
  }

  function ensureSession() {
    if (!socket || socket.readyState > 1) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws`);
      socket.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.op === 'out' && term) term.write(msg.data);
      });
    }
    if (!term && window.Terminal) {
      term = new window.Terminal({
        fontFamily: "'Fira Code', ui-monospace, 'Cascadia Code', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.22,
        theme: crtOn() ? THEME_CRT : THEME_SHARP,
        cursorBlink: true,
        cursorStyle: 'block',
        convertEol: false,
        cols: 100,
        rows: 32,
        scrollback: 2000
      });
      if (window.FitAddon && window.FitAddon.FitAddon) {
        fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
      }
      term.open(container);
      term.onData((data) => send({ op: 'in', data }));
      window.addEventListener('resize', () => {
        if (!modal?.classList.contains('open')) return;
        emitSize();
      });
      new MutationObserver(() => applyTheme()).observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
      });
    }
  }

  function whenOpen(cb) {
    if (socket && socket.readyState === 1) cb();
    else if (socket) socket.addEventListener('open', cb, { once: true });
  }

  window.openWebTerminal = () => {
    if (modal) modal.classList.add('open');
    let max = false;
    try { max = localStorage.getItem('shrc-tty-max') === '1'; } catch {}
    setMax(max);
    ensureSession();
    requestAnimationFrame(() => {
      applyTheme();
      whenOpen(() => {
        const s = size();
        if (!started) {
          send({ op: 'start', ...s });
          started = true;
        } else {
          send({ op: 'resize', ...s });
        }
        term?.focus();
      });
    });
  };

  function closeModal() {
    if (modal) modal.classList.remove('open');
  }

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (maxBtn) {
    maxBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMax(!win?.classList.contains('max'));
    });
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (!modal?.classList.contains('open')) return;
    if (e.key === 'Escape') closeModal();
    if (e.key === 'F11') {
      e.preventDefault();
      setMax(!win?.classList.contains('max'));
    }
  });
}
