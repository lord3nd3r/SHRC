export function initTerminalClient(containerId, closeBtnId) {
  const container = document.getElementById(containerId);
  const modal = document.getElementById('terminal-modal');
  const closeBtn = document.getElementById(closeBtnId);
  if (!container) return;

  let socket = null;
  let term = null;
  let fitAddon = null;
  let started = false;

  function size() {
    if (term && fitAddon) {
      try { fitAddon.fit(); } catch {}
    }
    const cols = term?.cols || 90;
    const rows = term?.rows || 30;
    return { cols, rows };
  }

  function ensureSession() {
    if (!socket) {
      socket = io({ autoConnect: true });
      socket.on('terminal:output', (data) => {
        if (term) term.write(data);
      });
    }
    if (!term && window.Terminal) {
      term = new window.Terminal({
        fontFamily: "'Fira Code', ui-monospace, monospace",
        fontSize: 13,
        lineHeight: 1.2,
        theme: {
          background: '#070b10',
          foreground: '#c9d1d9',
          cursor: '#3fb950',
          green: '#3fb950',
          cyan: '#58a6ff',
          yellow: '#d29922',
          magenta: '#d2a8ff',
          red: '#f85149',
          brightGreen: '#56d364'
        },
        cursorBlink: false,
        convertEol: false,
        cols: 100,
        rows: 32
      });
      if (window.FitAddon && window.FitAddon.FitAddon) {
        fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
      }
      term.open(container);
      term.onData((data) => socket.emit('terminal:input', data));
      window.addEventListener('resize', () => {
        if (!modal?.classList.contains('open')) return;
        const s = size();
        socket.emit('terminal:resize', s);
      });
    }
  }

  window.openWebTerminal = () => {
    if (modal) modal.classList.add('open');
    ensureSession();
    requestAnimationFrame(() => {
      const s = size();
      if (!started) {
        socket.emit('terminal:start', s);
        started = true;
      } else {
        socket.emit('terminal:resize', s);
      }
      term?.focus();
    });
  };

  function closeModal() {
    if (modal) modal.classList.remove('open');
  }

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal?.classList.contains('open')) closeModal();
  });
}
