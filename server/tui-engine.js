import { state } from './state.js';
import { irc, queryPeer } from './irc.js';
import { mircToAnsi, wrapMirc } from './mirc.js';

const ANSI = {
  clear: '\x1b[2J\x1b[H',
  clearLine: '\x1b[K',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  moveTo: (r, c) => `\x1b[${r};${c}H`,
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reverse: '\x1b[7m',
  enableMouse: '\x1b[?1000h\x1b[?1002h\x1b[?1006h',
  disableMouse: '\x1b[?1000l\x1b[?1002l\x1b[?1006l',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightRed: '\x1b[91m',
  black: '\x1b[30m',
  bgGreen: '\x1b[42m'
};

const SECRET_CMDS = /^(identify|id|register|oper|ghost|drop)\b/i;

function stripAnsi(str) {
  return (str || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function padAnsi(str, targetWidth) {
  const visibleLen = stripAnsi(str).length;
  const padding = Math.max(0, targetWidth - visibleLen);
  return (str || '') + ' '.repeat(padding);
}

function padLeft(str, n) {
  const s = String(str);
  return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;
}

function hhmm(ts, hour12) {
  const d = new Date(ts || Date.now());
  const min = String(d.getMinutes()).padStart(2, '0');
  if (hour12) {
    let h = d.getHours() % 12;
    if (h === 0) h = 12;
    return String(h).padStart(2, ' ') + ':' + min;
  }
  return String(d.getHours()).padStart(2, '0') + ':' + min;
}

function wrapText(text, width) {
  if (width <= 4) return [String(text || '')];
  const raw = String(text || '');
  if (raw.length <= width) return [raw];
  const out = [];
  let rest = raw;
  while (rest.length > width) {
    let breakAt = rest.lastIndexOf(' ', width);
    if (breakAt < Math.floor(width / 3)) breakAt = width;
    out.push(rest.slice(0, breakAt));
    rest = rest.slice(breakAt).trimStart();
  }
  if (rest) out.push(rest);
  return out.length ? out : [''];
}

function displayBufferName(room, myNick) {
  if (room === '*server*') return '*server*';
  if (String(room).startsWith('query:')) return queryPeer(room, myNick) || room;
  return room;
}

function maskInput(raw) {
  if (!raw.startsWith('/')) return raw;
  const body = raw.slice(1);
  const sp = body.indexOf(' ');
  if (sp === -1) return raw;
  const cmd = body.slice(0, sp);
  if (!SECRET_CMDS.test(cmd)) return raw;
  return '/' + cmd + ' ' + '*'.repeat(Math.max(0, body.length - sp - 1));
}

export class TUISession {
  constructor(clientStream, userKey = {}) {
    this.stream = clientStream;
    this.sessionId = 's-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    this.ip = userKey.ip || '0.0.0.0';
    this.fingerprint = userKey.fingerprint || 'anon:' + Math.random().toString(36).slice(2, 8);

    this.cols = clientStream.columns || 120;
    this.rows = clientStream.rows || 32;

    this.chatInput = '';
    this.inputHistory = [];
    this.historyIdx = -1;
    this.scrollOffset = 0;
    this.statusMessage = '';
    this.localLines = new Map();
    this.unread = new Map();
    this.lastCount = new Map();
    this.hitTargets = [];
    this.alive = true;
    this.banned = false;
    this.hour12 = !!userKey.hour12;
    this.beepOn = !!userKey.beep;
    this.useMouse = userKey.mouse === true;

    const via = userKey.via || (String(this.fingerprint).startsWith('web:') || userKey.noMouse ? 'web' : 'ssh');
    const joined = irc.connect({
      id: this.sessionId,
      nick: userKey.username,
      fingerprint: this.fingerprint,
      ip: this.ip,
      via,
      realname: userKey.realname || (via === 'web' ? 'web' : 'anon'),
      onKill: (reason) => this.forceQuit(reason)
    });

    if (joined.banned) {
      this.banned = true;
      this.client = null;
      this.activeBuffer = '*server*';
      this.write((this.useMouse ? ANSI.enableMouse : '') + ANSI.clear);
      this.write(ANSI.red + `\r\n  banned from shrc (${joined.ban.reason})\r\n` + ANSI.reset);
      this.forceQuit('banned: ' + joined.ban.reason);
      return;
    }

    this.client = joined.client;
    this.client.pushNotice = (lines) => this.deliverNotices(lines);
    this.activeBuffer = '*server*';
    this.addLocal('*server*', { type: 'server', author: 'shrc', text: '- shrc motd -', timestamp: Date.now() });
    for (const line of joined.motd) {
      this.addLocal('*server*', { type: 'server', author: 'shrc', text: line, timestamp: Date.now() });
    }
    this.addLocal('*server*', { type: 'server', author: 'shrc', text: `you are ${this.client.nick}  fp ${this.client.fingerprint}`, timestamp: Date.now() });

    for (const res of irc.autoJoinChannels(this.client)) this.applyResult(res);
    if (joined.nickserv && joined.nickserv.length) this.deliverNotices(joined.nickserv);

    this.unsubscribeState = state.subscribe(() => {
      if (this.alive) this.onStateChange();
    });

    this.write((this.useMouse ? ANSI.enableMouse : '') + ANSI.clear);
    this.render();
  }

  clientNick() {
    return this.client ? this.client.nick : 'anon';
  }

  deliverNotices(lines) {
    if (!this.alive || !lines?.length) return;
    const dest = this.activeBuffer || '*server*';
    for (const line of lines) {
      this.addLocal(dest, line);
      if (dest !== '*server*') this.addLocal('*server*', line);
    }
    const last = lines[lines.length - 1];
    this.statusMessage = ANSI.yellow + `-${last.author || 'NickServ'}- ` + last.text + ANSI.reset;
    this.render();
  }

  addLocal(buffer, line) {
    const key = buffer || '*server*';
    const arr = this.localLines.get(key) || [];
    arr.push({
      id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type: line.type || 'server',
      author: line.author || 'shrc',
      text: line.text,
      timestamp: line.timestamp || Date.now(),
      local: true
    });
    if (arr.length > 200) arr.shift();
    this.localLines.set(key, arr);
  }

  applyResult(res) {
    if (!res) return;
    if (res.clear) this.localLines.set(this.activeBuffer, []);
    if (res.switchBuffer) this.activeBuffer = res.switchBuffer;
    if (res.openQuery && this.client) this.client.queries.add(res.openQuery);
    const dest = res.switchBuffer || this.activeBuffer;
    for (const line of res.lines || []) this.addLocal(dest, line);
    if (res.error) this.statusMessage = ANSI.brightRed + res.error + ANSI.reset;
    else if (res.status) this.statusMessage = ANSI.brightGreen + res.status + ANSI.reset;
    if (res.quit) this.quit(res.reason);
    if (this.client) {
      if (typeof this.client.hour12 === 'boolean') this.hour12 = this.client.hour12;
      if (typeof this.client.beep === 'boolean') this.beepOn = this.client.beep;
    }
  }

  onStateChange() {
    if (this.client) {
      for (const b of irc.buffers(this.client)) {
        const n = (state.chat[b] || []).length;
        const prev = this.lastCount.get(b) || n;
        if (n > prev && b !== this.activeBuffer) {
          this.unread.set(b, (this.unread.get(b) || 0) + (n - prev));
        }
        if (n > prev && this.beepOn) {
          const msgs = (state.chat[b] || []).slice(prev);
          const me = (this.clientNick() || '').toLowerCase();
          if (me && msgs.some((m) => String(m.text || '').toLowerCase().includes(me))) {
            if (typeof this.stream.beep === 'function') this.stream.beep();
          }
        }
        this.lastCount.set(b, n);
      }
    }
    this.render();
  }

  destroy() {
    this.alive = false;
    this.write(ANSI.disableMouse + ANSI.showCursor);
    if (this.unsubscribeState) this.unsubscribeState();
    if (this.client) irc.disconnect(this.sessionId, 'Connection closed');
    this.client = null;
  }

  write(data) {
    if (this.stream && this.stream.writable !== false) {
      try { this.stream.write(data); } catch {}
    }
  }

  closeStream() {
    try {
      if (this.stream) {
        if (typeof this.stream.end === 'function') this.stream.end();
        else if (typeof this.stream.close === 'function') this.stream.close();
      }
    } catch {}
    if (typeof this.stream?.disconnectSocket === 'function') {
      try { this.stream.disconnectSocket(); } catch {}
    }
  }

  quit(reason = 'Quit') {
    if (!this.alive) return;
    this.alive = false;
    this.write(ANSI.showCursor + ANSI.disableMouse + ANSI.clear + ANSI.green + `*** ${reason || 'Quit'}\r\n` + ANSI.reset);
    if (this.unsubscribeState) this.unsubscribeState();
    if (this.client) irc.disconnect(this.sessionId, reason);
    this.client = null;
    this.closeStream();
  }

  forceQuit(reason) {
    this.statusMessage = ANSI.red + reason + ANSI.reset;
    this.quit(reason);
  }

  handleResize(cols, rows) {
    this.cols = cols || 120;
    this.rows = rows || 32;
    this.write(ANSI.clear);
    this.render();
  }

  handleInput(data) {
    if (!this.alive || this.banned) return;
    const raw = data.toString('utf-8');

    const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let match;
    let handledMouse = false;
    while ((match = sgrRegex.exec(raw)) !== null) {
      handledMouse = true;
      const btn = parseInt(match[1], 10);
      const col = parseInt(match[2], 10);
      const row = parseInt(match[3], 10);
      if (match[4] === 'M') {
        if (btn === 0) this.handleMouseClick(col, row);
        else if (btn === 64) this.handleMouseScroll(-1);
        else if (btn === 65) this.handleMouseScroll(1);
      }
    }
    if (handledMouse) return;

    if (raw === '\x03') {
      this.chatInput = '';
      this.statusMessage = ANSI.gray + 'cleared. /quit or /exit to leave.' + ANSI.reset;
      this.render();
      return;
    }

    if (raw === '\x1b[5~') { this.scrollOffset += Math.max(4, this.rows - 10); this.render(); return; }
    if (raw === '\x1b[6~') { this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(4, this.rows - 10)); this.render(); return; }
    if (raw === '\x1b[A') { this.recallHistory(-1); return; }
    if (raw === '\x1b[B') { this.recallHistory(1); return; }
    if (raw === '\x10') { this.cycleBuffer(-1); return; }
    if (raw === '\x0e') { this.cycleBuffer(1); return; }
    if (raw === '\t') { this.tabComplete(); return; }
    if (raw === '\x0b') {
      this.chatInput += '\x03';
      this.statusMessage = ANSI.yellow + 'color: 0-15  optional ,bg  e.g. Ctrl+K 4 = red. Ctrl+O reset' + ANSI.reset;
      this.render();
      return;
    }
    if (raw === '\x02') { this.chatInput += '\x02'; this.render(); return; }
    if (raw === '\x0f') { this.chatInput += '\x0f'; this.render(); return; }
    if (raw === '\x12' || raw === '\x16') { this.chatInput += '\x16'; this.render(); return; }
    if (raw === '\x15' || raw === '\x1f') { this.chatInput += '\x1f'; this.render(); return; }

    this.handleChatInput(raw);
  }

  recallHistory(dir) {
    if (!this.inputHistory.length) return;
    if (this.historyIdx === -1) this.historyIdx = this.inputHistory.length;
    this.historyIdx = Math.max(0, Math.min(this.inputHistory.length, this.historyIdx + dir));
    this.chatInput = this.historyIdx >= this.inputHistory.length ? '' : this.inputHistory[this.historyIdx];
    this.render();
  }

  cycleBuffer(dir) {
    if (!this.client) return;
    const bufs = irc.buffers(this.client);
    if (!bufs.length) return;
    let i = bufs.indexOf(this.activeBuffer);
    if (i < 0) i = 0;
    i = (i + dir + bufs.length) % bufs.length;
    this.activeBuffer = bufs[i];
    this.unread.set(this.activeBuffer, 0);
    this.scrollOffset = 0;
    this.render();
  }

  tabComplete() {
    if (!this.client) return;
    const parts = this.chatInput.split(' ');
    const last = parts[parts.length - 1] || '';
    const prefix = last.replace(/^[@+]/, '');
    if (!prefix) return;
    const names = [];
    if (this.activeBuffer.startsWith('#')) {
      for (const n of irc.nicklist(this.activeBuffer)) names.push(n.nick);
    }
    for (const b of irc.buffers(this.client)) names.push(displayBufferName(b, this.client.nick));
    const hits = [...new Set(names)].filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()));
    if (hits.length === 1) {
      const trail = parts.length === 1 && !this.chatInput.startsWith('/') ? ': ' : ' ';
      if (trail === ': ') this.chatInput = hits[0] + ': ';
      else {
        parts[parts.length - 1] = hits[0] + trail;
        this.chatInput = parts.join(' ');
      }
      this.render();
    } else if (hits.length > 1) {
      this.statusMessage = ANSI.cyan + hits.slice(0, 12).join('  ') + ANSI.reset;
      this.render();
    }
  }

  handleMouseClick(col, row) {
    const hit = this.hitTargets.find((t) => col >= t.x1 && col <= t.x2 && row >= t.y1 && row <= t.y2);
    if (!hit) return;
    if (hit.type === 'buffer') {
      this.activeBuffer = hit.buffer;
      this.unread.set(hit.buffer, 0);
      this.scrollOffset = 0;
      this.render();
      return;
    }
    if (hit.type === 'nick' && this.client) {
      const dest = irc.findNick(hit.nick);
      if (!dest || dest === this.client) return;
      const room = ['query', ...[this.client.nick.toLowerCase(), dest.nick.toLowerCase()].sort()].join(':');
      this.client.queries.add(dest.nick);
      dest.queries.add(this.client.nick);
      this.activeBuffer = room;
      this.render();
    }
  }

  handleMouseScroll(dir) {
    if (dir < 0) this.scrollOffset += 3;
    else this.scrollOffset = Math.max(0, this.scrollOffset - 3);
    this.render();
  }

  handleChatInput(key) {
    if (key === '\r' || key === '\n') {
      const input = this.chatInput;
      this.chatInput = '';
      this.historyIdx = -1;
      if (!input.trim()) { this.render(); return; }
      const low = input.trim().toLowerCase();
      if (low === 'qq' || low === '/quit' || low === '/exit' || low.startsWith('/quit ') || low.startsWith('/exit ')) {
        const reason = input.trim().replace(/^\/?(quit|exit)\s*/i, '') || 'Quit';
        this.quit(reason);
        return;
      }
      if (low === '/set mouse on') {
        this.useMouse = true;
        this.write(ANSI.enableMouse);
        this.statusMessage = ANSI.brightGreen + 'Mouse on. Shift-drag to copy.' + ANSI.reset;
        this.render();
        return;
      }
      if (low === '/set mouse off') {
        this.useMouse = false;
        this.write(ANSI.disableMouse);
        this.statusMessage = ANSI.brightGreen + 'Mouse off. Drag-select copies in your terminal.' + ANSI.reset;
        this.render();
        return;
      }
      this.inputHistory.push(input);
      if (this.inputHistory.length > 80) this.inputHistory.shift();
      if (!this.client) return;
      this.applyResult(irc.exec(this.client, this.activeBuffer, input));
      this.scrollOffset = 0;
      if (this.alive) this.render();
      return;
    }
    if (key === '\x7f' || key === '\x08') {
      this.chatInput = this.chatInput.slice(0, -1);
    } else if (key.length === 1 && (key >= ' ' || key === '\x02' || key === '\x03' || key === '\x0f' || key === '\x16' || key === '\x1d' || key === '\x1f')) {
      this.chatInput += key;
    }
    this.render();
  }

  mergedMessages(buffer) {
    const persisted = (state.chat[buffer] || []).filter((m) => {
      if (!this.client) return true;
      return !this.client.ignores.has(String(m.author || '').toLowerCase());
    });
    const local = this.localLines.get(buffer) || [];
    return persisted.concat(local).sort((a, b) => a.timestamp - b.timestamp);
  }

  formatMessages(buffer, centerWidth) {
    const nickWidth = 12;
    const textWidth = Math.max(16, centerWidth - (5 + 1 + nickWidth + 3));
    const my = this.clientNick();
    const myL = my.toLowerCase();
    const lines = [];
    for (const m of this.mergedMessages(buffer)) {
      const time = ANSI.gray + hhmm(m.timestamp, this.hour12) + ANSI.reset;
      const type = m.type || 'privmsg';
      if (type === 'join' || type === 'part' || type === 'quit' || type === 'nick' || type === 'mode' || type === 'kick' || type === 'topic' || type === 'server') {
        const color = type === 'kick' ? ANSI.red : type === 'topic' || type === 'mode' ? ANSI.yellow : ANSI.gray;
        const wrapped = wrapText(String(m.text || '').replace(/[\x02\x03\x0f\x16\x1d\x1f]/g, ''), Math.max(16, centerWidth - 10));
        wrapped.forEach((w, i) => {
          const nickCol = i === 0 ? ANSI.dim + padLeft('*', nickWidth) + ANSI.reset : ' '.repeat(nickWidth);
          lines.push(`${i === 0 ? time : '     '} ${nickCol} ${color}${w}${ANSI.reset}`);
        });
        continue;
      }
      if (type === 'action') {
        const wrapped = wrapText(`* ${m.author} ${m.text}`, Math.max(16, centerWidth - 10));
        wrapped.forEach((w, i) => {
          const nickCol = i === 0 ? ANSI.magenta + padLeft('*', nickWidth) + ANSI.reset : ' '.repeat(nickWidth);
          lines.push(`${i === 0 ? time : '     '} ${nickCol} ${ANSI.magenta}${w}${ANSI.reset}`);
        });
        continue;
      }
      if (type === 'notice') {
        const wrapped = wrapText(m.text, textWidth);
        wrapped.forEach((w, i) => {
          const nickCol = i === 0 ? ANSI.yellow + padLeft('-' + m.author + '-', nickWidth) + ANSI.reset : ' '.repeat(nickWidth);
          lines.push(`${i === 0 ? time : '     '} ${nickCol} ${ANSI.yellow}${w}${ANSI.reset}`);
        });
        continue;
      }
      const hl = m.text && m.text.toLowerCase().includes(myL);
      const isSelf = String(m.author).toLowerCase() === myL;
      const online = this.client && buffer.startsWith('#') ? irc.findNick(m.author) : null;
      const prefix = (m.extra && m.extra.prefix != null)
        ? m.extra.prefix
        : (online ? irc.prefix(online, buffer) : '');
      const nickColor = isSelf ? ANSI.brightGreen : hl ? ANSI.brightYellow : ANSI.cyan;
      const nickStr = padLeft((prefix || '') + m.author, nickWidth);
      const wrapped = wrapMirc(m.text, textWidth);
      wrapped.forEach((w, i) => {
        const nickCol = i === 0 ? ANSI.bold + nickColor + nickStr + ANSI.reset : ' '.repeat(nickWidth);
        const body = hl ? ANSI.brightYellow + w + ANSI.reset : w;
        lines.push(`${i === 0 ? time : '     '} ${nickCol} ${body}`);
      });
    }
    return lines;
  }

  render() {
    if (!this.alive) return;
    const leftWidth = 20;
    const rightWidth = String(this.activeBuffer).startsWith('#') ? 18 : 0;
    const centerWidth = Math.max(36, this.cols - leftWidth - rightWidth - (rightWidth ? 2 : 1));
    const totalRows = Math.max(16, this.rows);
    this.hitTargets = [];

    const c = this.client;
    const nick = this.clientNick();
    const online = state.stats.activeUsers || irc.clients.size || 1;
    const flags = [];
    if (c?.oper) flags.push('*');
    if (c?.identified) flags.push('+');
    if (c?.away) flags.push('z');

    const leftHead = ANSI.bold + ANSI.green + 'shrc' + ANSI.reset + ANSI.gray + '  irc' + ANSI.reset;
    const rightHead = ANSI.gray + flags.join('') + ANSI.reset + ' ' +
      ANSI.cyan + nick + ANSI.reset + ANSI.gray + ' · ' + online + ' online' + ANSI.reset;

    const leftCol = [];
    const rightCol = [];
    const centerCol = [];

    if (c) {
      leftCol.push(ANSI.dim + ANSI.gray + ' buffers' + ANSI.reset);
      const bufs = irc.buffers(c);
      bufs.forEach((b, idx) => {
        const name = displayBufferName(b, nick);
        const active = b === this.activeBuffer;
        const n = this.unread.get(b) || 0;
        const mark = n > 0 ? ANSI.brightYellow + '●' + ANSI.reset : ' ';
        const label = (name + '            ').slice(0, 14);
        const text = active
          ? ANSI.bgGreen + ANSI.black + ' ' + label + ANSI.reset
          : ANSI.gray + ' ' + label + ANSI.reset + ' ' + mark;
        leftCol.push(text);
        this.hitTargets.push({
          type: 'buffer',
          buffer: b,
          x1: 1,
          x2: leftWidth,
          y1: 4 + idx,
          y2: 4 + idx
        });
      });
      leftCol.push('');
      leftCol.push(ANSI.dim + ANSI.gray + ' keys' + ANSI.reset);
      leftCol.push(ANSI.gray + ' ^N ^P  buffers' + ANSI.reset);
      leftCol.push(ANSI.gray + ' pgup    scroll' + ANSI.reset);
      leftCol.push(ANSI.gray + ' tab     nick' + ANSI.reset);
      leftCol.push(ANSI.gray + ' /op /deop' + ANSI.reset);
      leftCol.push(ANSI.gray + ' /help' + ANSI.reset);
    }

    const buf = this.activeBuffer;
    const msgs = this.formatMessages(buf, centerWidth);
    const maxContentRows = totalRows - 6;
    const maxScroll = Math.max(0, msgs.length - maxContentRows);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const end = msgs.length - this.scrollOffset;
    const start = Math.max(0, end - maxContentRows);
    for (const line of msgs.slice(start, end)) centerCol.push(line);
    if (this.scrollOffset > 0) {
      centerCol.push(ANSI.yellow + ` ↑ ${this.scrollOffset} more (pgdn to follow)` + ANSI.reset);
    }

    if (String(buf).startsWith('#') && c) {
      rightCol.push(ANSI.dim + ANSI.gray + ' names' + ANSI.reset);
      irc.nicklist(buf).forEach((n, idx) => {
        const pcol = n.prefix === '~' || n.prefix === '@' ? ANSI.green
          : n.prefix === '&' ? ANSI.magenta
          : n.prefix === '%' ? ANSI.cyan
          : n.prefix === '+' ? ANSI.yellow
          : ANSI.gray;
        const away = n.away ? ANSI.dim : '';
        rightCol.push(away + pcol + (n.prefix || ' ') + n.nick + ANSI.reset);
        this.hitTargets.push({
          type: 'nick',
          nick: n.nick,
          x1: this.cols - rightWidth + 1,
          x2: this.cols,
          y1: 4 + idx,
          y2: 4 + idx
        });
      });
    }

    const lines = [];
    const gap = Math.max(1, this.cols - stripAnsi(leftHead).length - stripAnsi(rightHead).length);
    lines.push(leftHead + ' '.repeat(gap) + rightHead);
    lines.push(ANSI.gray + '─'.repeat(Math.min(this.cols, 200)) + ANSI.reset);

    for (let r = 0; r < maxContentRows; r++) {
      const leftPart = padAnsi(leftCol[r] || '', leftWidth);
      const centerPart = padAnsi(centerCol[r] || '', centerWidth);
      const rightPart = rightWidth ? padAnsi(rightCol[r] || '', rightWidth) : '';
      lines.push(rightWidth ? `${leftPart} ${centerPart} ${rightPart}` : `${leftPart} ${centerPart}`);
    }

    lines.push(ANSI.gray + '─'.repeat(Math.min(this.cols, 200)) + ANSI.reset);

    const ch = buf && buf.startsWith('#') ? state.channels[buf] : null;
    const modeStr = ch ? '+' + Object.entries(ch.modes).filter(([k, v]) => v && k.length === 1 && k !== 'k' && k !== 'l').map(([k]) => k).join('') + (ch.modes.k ? 'k' : '') + (ch.modes.l ? 'l' : '') : '';
    const nNicks = ch && c ? irc.nicklist(buf).length : 0;
    const topic = ch ? (ch.topic || 'no topic') : (buf && String(buf).startsWith('query:') ? 'query' : 'server');
    const topicLine = this.statusMessage
      ? ' ' + this.statusMessage
      : ANSI.gray + ` [${hhmm(Date.now(), this.hour12)}] ${modeStr} ${nNicks ? nNicks + ' nicks' : ''} │ ${topic}` + ANSI.reset;
    lines.push(topicLine.slice(0, this.cols + 32));

    const shownInput = mircToAnsi(maskInput(this.chatInput));
    const chanTag = displayBufferName(buf, nick);
    const opMark = c && buf && buf.startsWith('#') ? (irc.prefix(c, buf) || '') : '';
    lines.push(ANSI.bold + ANSI.green + `[${opMark}${chanTag}]` + ANSI.reset + ' ' + shownInput + ANSI.brightGreen + '▋' + ANSI.reset);
    lines.push(ANSI.gray + '/quit /exit · drag-select copy · ^C clear · ^K color · /help' + ANSI.reset);

    let out = ANSI.hideCursor + ANSI.moveTo(1, 1);
    lines.slice(0, this.rows).forEach((line, i) => {
      out += ANSI.moveTo(i + 1, 1) + ANSI.clearLine + line;
    });
    this.write(out);
  }
}
