const FG = [
  15, 0, 4, 2, 9, 88, 5, 208,
  11, 10, 6, 14, 12, 13, 8, 7
];
const BG = FG;

function ansiFg(n) {
  if (n == null || n < 0) return '';
  const c = n < 16 ? FG[n] : Math.min(n, 98);
  return `\x1b[38;5;${c}m`;
}
function ansiBg(n) {
  if (n == null || n < 0) return '';
  const c = n < 16 ? BG[n] : Math.min(n, 98);
  return `\x1b[48;5;${c}m`;
}

function readNum(s, i) {
  let n = '';
  if (i < s.length && s[i] >= '0' && s[i] <= '9') n += s[i++];
  if (i < s.length && s[i] >= '0' && s[i] <= '9') n += s[i++];
  return { n: n === '' ? null : Math.min(99, parseInt(n, 10)), i };
}

export function tokenizeMirc(s) {
  const str = String(s || '');
  const tokens = [];
  let bold = false;
  let ul = false;
  let rev = false;
  let italic = false;
  let fg = null;
  let bg = null;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    tokens.push({ text: buf, bold, ul, rev, italic, fg, bg });
    buf = '';
  };
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x02) { flush(); bold = !bold; continue; }
    if (code === 0x1f) { flush(); ul = !ul; continue; }
    if (code === 0x16) { flush(); rev = !rev; continue; }
    if (code === 0x1d) { flush(); italic = !italic; continue; }
    if (code === 0x0f) {
      flush();
      bold = ul = rev = italic = false;
      fg = bg = null;
      continue;
    }
    if (code === 0x03) {
      flush();
      const a = readNum(str, i + 1);
      if (a.n == null) {
        fg = bg = null;
        continue;
      }
      fg = a.n;
      i = a.i - 1;
      if (str[i + 1] === ',') {
        const b = readNum(str, i + 2);
        if (b.n != null) {
          bg = b.n;
          i = b.i - 1;
        } else i += 1;
      }
      continue;
    }
    buf += str[i];
  }
  flush();
  return tokens;
}

export function visibleLength(s) {
  return tokenizeMirc(s).reduce((n, t) => n + t.text.length, 0);
}

function stylePrefix(t) {
  let a = '\x1b[0m';
  if (t.bold) a += '\x1b[1m';
  if (t.ul) a += '\x1b[4m';
  if (t.rev) a += '\x1b[7m';
  if (t.italic) a += '\x1b[3m';
  a += ansiFg(t.fg);
  a += ansiBg(t.bg);
  return a;
}

export function tokensToAnsi(tokens) {
  if (!tokens.length) return '';
  return tokens.map((t) => stylePrefix(t) + t.text).join('') + '\x1b[0m';
}

export function mircToAnsi(s) {
  return tokensToAnsi(tokenizeMirc(s));
}

export function wrapMirc(s, width) {
  const w = Math.max(4, width || 40);
  const tokens = tokenizeMirc(s);
  const lines = [];
  let cur = [];
  let len = 0;
  const pushLine = () => {
    lines.push(tokensToAnsi(cur));
    cur = [];
    len = 0;
  };
  for (const t of tokens) {
    let rest = t.text;
    while (rest.length) {
      const room = w - len;
      if (room <= 0) {
        pushLine();
        continue;
      }
      if (rest.length <= room) {
        cur.push({ ...t, text: rest });
        len += rest.length;
        rest = '';
      } else {
        let cut = room;
        const slice = rest.slice(0, room);
        const sp = slice.lastIndexOf(' ');
        if (sp > room / 3) cut = sp + 1;
        cur.push({ ...t, text: rest.slice(0, cut) });
        rest = rest.slice(cut).replace(/^\s+/, '');
        pushLine();
      }
    }
  }
  if (cur.length) pushLine();
  return lines.length ? lines : [''];
}
