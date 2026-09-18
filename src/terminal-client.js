const XTERM_THEMES = {
  phosphor: {
    background: '#020805',
    foreground: '#39ff6a',
    cursor: '#39ff6a',
    cursorAccent: '#020805',
    selectionBackground: '#1f8a3a',
    black: '#020805', red: '#ff5a5a', green: '#39ff6a', yellow: '#d4ff7a',
    blue: '#7dffd4', magenta: '#c4ff90', cyan: '#7dffd4', white: '#e8ffe8',
    brightBlack: '#4d8a5c', brightRed: '#ff8080', brightGreen: '#6dff90',
    brightYellow: '#f0ffb0', brightBlue: '#b0ffe8', brightMagenta: '#dcffb8',
    brightCyan: '#b8fff0', brightWhite: '#ffffff'
  },
  amber: {
    background: '#120b02',
    foreground: '#ffb020',
    cursor: '#ffcc66',
    cursorAccent: '#120b02',
    selectionBackground: '#5c3d12',
    black: '#120b02', red: '#ff6a3a', green: '#c8a030', yellow: '#ffe08a',
    blue: '#c09050', magenta: '#e09060', cyan: '#e0c070', white: '#ffe8c0',
    brightBlack: '#a67c3d', brightRed: '#ff8a60', brightGreen: '#e0c050',
    brightYellow: '#fff0b0', brightBlue: '#e0b070', brightMagenta: '#ffc090',
    brightCyan: '#fff0c8', brightWhite: '#fffaf0'
  },
  ice: {
    background: '#061018',
    foreground: '#c8e8f8',
    cursor: '#7ec8e8',
    cursorAccent: '#061018',
    selectionBackground: '#1a4a62',
    black: '#061018', red: '#ff7a8a', green: '#7ec8e8', yellow: '#a8fff0',
    blue: '#5aa0d0', magenta: '#a0c8e8', cyan: '#7ec8e8', white: '#e8f8ff',
    brightBlack: '#5a8aa0', brightRed: '#ff9aa8', brightGreen: '#b0e0f8',
    brightYellow: '#d0fff8', brightBlue: '#90c8f0', brightMagenta: '#c8e0f8',
    brightCyan: '#d0f8ff', brightWhite: '#ffffff'
  },
  slate: {
    background: '#121212',
    foreground: '#d8d8d8',
    cursor: '#e8e8e8',
    cursorAccent: '#121212',
    selectionBackground: '#3a3a3a',
    black: '#121212', red: '#ff6b6b', green: '#b0b0b0', yellow: '#f0c060',
    blue: '#a0a0a0', magenta: '#c0c0c0', cyan: '#b8b8b8', white: '#e8e8e8',
    brightBlack: '#888888', brightRed: '#ff8a8a', brightGreen: '#d0d0d0',
    brightYellow: '#ffe08a', brightBlue: '#c8c8c8', brightMagenta: '#e0e0e0',
    brightCyan: '#f0f0f0', brightWhite: '#ffffff'
  },
  paper: {
    background: '#f4efe4',
    foreground: '#2a2418',
    cursor: '#3d5a2c',
    cursorAccent: '#f4efe4',
    selectionBackground: '#c4b89a',
    black: '#2a2418', red: '#a03020', green: '#3d5a2c', yellow: '#8a4a12',
    blue: '#2a4a6a', magenta: '#6a3a5a', cyan: '#2a5a5a', white: '#f4efe4',
    brightBlack: '#6a5e48', brightRed: '#c04030', brightGreen: '#5a7a40',
    brightYellow: '#b06020', brightBlue: '#3a6a8a', brightMagenta: '#8a4a6a',
    brightCyan: '#3a7a7a', brightWhite: '#ffffff'
  }
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
  let pingTimer = null;
  let reconnectTimer = null;
  let reconnects = 0;

  function applyTheme() {
    if (!term) return;
    const id = document.body.dataset.theme || 'phosphor';
    term.options.theme = XTERM_THEMES[id] || XTERM_THEMES.phosphor;
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

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => send({ op: 'ping' }), 15000);
  }

  function scheduleReconnect() {
    if (!modal?.classList.contains('open')) return;
    if (reconnectTimer) return;
    const wait = Math.min(8000, 400 * (2 ** reconnects));
    reconnects += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!modal?.classList.contains('open')) return;
      started = false;
      ensureSession();
      whenOpen(() => {
        send({ op: 'start', ...size() });
        started = true;
        if (term) {
          term.write('\r\n\x1b[33mreconnected\x1b[0m\r\n');
        }
        term?.focus();
      });
    }, wait);
  }

  function ensureSession() {
    if (!socket || socket.readyState > 1) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws`);
      socket.addEventListener('open', () => {
        reconnects = 0;
        startPing();
      });
      socket.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.op === 'ping') { send({ op: 'pong' }); return; }
        if (msg.op === 'out' && term) term.write(msg.data);
      });
      socket.addEventListener('close', () => {
        stopPing();
        started = false;
        scheduleReconnect();
      });
      socket.addEventListener('error', () => {});
    }
    if (!term && window.Terminal) {
      term = new window.Terminal({
        fontFamily: "'Fira Code', ui-monospace, 'Cascadia Code', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.22,
        theme: XTERM_THEMES[document.body.dataset.theme] || XTERM_THEMES.phosphor,
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
        attributeFilter: ['class', 'data-theme']
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
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopPing();
    try { socket?.close(); } catch {}
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
