import tls from 'tls';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { irc, hostmask } from './irc.js';
import { state, normalizeChannel } from './state.js';
import { handleService } from './services.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SERVER = process.env.IRC_TLS_CN || process.env.IRC_SERVER_NAME || 'shrc';

function parseLine(line) {
  let rest = line.replace(/\r$/, '');
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const parts = [];
  while (rest.length) {
    if (rest.startsWith(':')) {
      parts.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(' ');
    if (sp === -1) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  const cmd = (parts.shift() || '').toUpperCase();
  return { prefix, cmd, args: parts };
}

function ensureTls() {
  const certPath = process.env.IRC_TLS_CERT || path.join(DATA_DIR, 'irc.crt');
  const keyPath = process.env.IRC_TLS_KEY || path.join(DATA_DIR, 'irc.key');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.log('[IRCS] Generating self-signed TLS cert for 6697...');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', keyPath, '-out', certPath,
      '-days', '825', '-nodes',
      '-subj', `/CN=${process.env.IRC_TLS_CN || 'shrc'}`
    ], { stdio: 'pipe' });
    try { fs.chmodSync(keyPath, 0o600); } catch {}
  }
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };
}

class IrcWire {
  constructor(socket) {
    this.socket = socket;
    this.ip = (socket.remoteAddress || '0.0.0.0').replace(/^::ffff:/, '');
    this.nick = '*';
    this.ident = 'user';
    this.realname = 'anon';
    this.gotNick = false;
    this.gotUser = false;
    this.client = null;
    this.buf = '';
    this.unsub = null;
    try { socket.setNoDelay(true); } catch {}
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.drop('Connection closed'));
    socket.on('error', () => this.drop('Connection error'));
  }

  send(line) {
    if (this.socket.writable) {
      try { this.socket.write(line + '\r\n'); } catch {}
    }
  }

  numeric(code, params, text) {
    const mid = params ? ' ' + params : '';
    const trail = text != null ? ' :' + text : '';
    this.send(`:${SERVER} ${code} ${this.nick}${mid}${trail}`);
  }

  mask() {
    return this.client ? hostmask(this.client) : `${this.nick}!${this.ident}@masked`;
  }

  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (line) this.handle(parseLine(line));
    }
    if (this.buf.length > 8192) this.buf = '';
  }

  register() {
    if (this.client || !this.gotNick || !this.gotUser) return;
    const joined = irc.connect({
      id: 'irc-' + crypto.randomBytes(6).toString('hex'),
      nick: this.nick === '*' ? null : this.nick,
      fingerprint: 'irc:' + crypto.randomBytes(8).toString('hex'),
      ip: this.ip,
      ident: this.ident,
      realname: this.realname,
      via: 'irc',
      onKill: (reason) => {
        this.send(`ERROR :${reason}`);
        this.socket.end();
      }
    });
    if (joined.banned) {
      this.send(`ERROR :banned (${joined.ban.reason})`);
      this.socket.end();
      return;
    }
    this.client = joined.client;
    this.nick = this.client.nick;
    this.client.pushNotice = (lines) => {
      for (const line of lines || []) {
        this.send(`:${line.author || 'NickServ'}!service@services.${SERVER} NOTICE ${this.nick} :${line.text}`);
      }
    };
    this.unsub = irc.on((ev) => this.onEvent(ev));
    this.numeric('001', '', `Welcome to shrc ${this.mask()}`);
    this.numeric('002', '', `Your host is ${SERVER}, running shrc`);
    this.numeric('003', '', 'This server was created for ssh and ircs');
    this.numeric('004', `${SERVER} shrc-1 iowstn ovb`);
    this.numeric('005', 'CHANTYPES=# PREFIX=(qaohv)~&@%+ NETWORK=shrc CASEMAPPING=rfc1459 CHANMODES=b,,kl,ntims', 'are supported by this server');
    this.numeric('251', '', `There are ${irc.humanCount()} users on 1 server`);
    this.numeric('375', '', `- ${SERVER} Message of the day -`);
    for (const line of joined.motd || []) this.numeric('372', '', '- ' + line);
    this.numeric('376', '', 'End of /MOTD command');
    for (const line of joined.nickserv || []) {
      this.send(`:NickServ!service@services.${SERVER} NOTICE ${this.nick} :${line.text}`);
    }
    this.send(`PING :${SERVER}`);
    for (const res of irc.autoJoinChannels(this.client)) {
      if (res.ok && res.switchBuffer) this.confirmJoin(res.switchBuffer);
    }
  }

  confirmJoin(chan) {
    this.send(`:${this.mask()} JOIN ${chan}`);
    const ch = state.channels[chan];
    if (ch?.topic) {
      this.numeric('332', chan, ch.topic);
      this.numeric('333', `${chan} ${ch.topicBy || SERVER} ${Math.floor((ch.topicAt || Date.now()) / 1000)}`);
    } else {
      this.numeric('331', chan, 'No topic is set');
    }
    this.names(chan);
  }

  drop(reason) {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.client) {
      irc.disconnect(this.client.id, reason || 'Quit');
      this.client = null;
    }
    try { this.socket.destroy(); } catch {}
  }

  onEvent(ev) {
    if (!this.client) return;
    const me = this.client;
    if (ev.kind === 'privmsg' || ev.kind === 'notice' || ev.kind === 'action') {
      if (ev.from === me) return;
      if (String(ev.room).startsWith('query:')) {
        const other = ev.author;
        if (lower(other) !== lower(me.nick) && ev.to !== me) return;
        const src = ev.from ? hostmask(ev.from) : `${ev.author}!user@hidden`;
        const text = ev.kind === 'action' ? `\x01ACTION ${ev.text}\x01` : ev.text;
        const cmd = ev.kind === 'notice' ? 'NOTICE' : 'PRIVMSG';
        if (ev.to === me || lower(other) === lower(me.nick)) {
          this.send(`:${src} ${cmd} ${me.nick} :${text}`);
        }
        return;
      }
      if (!me.channels.has(ev.room)) return;
      const src = ev.from ? hostmask(ev.from) : `${ev.author}!user@hidden`;
      const text = ev.kind === 'action' ? `\x01ACTION ${ev.text}\x01` : ev.text;
      const cmd = ev.kind === 'notice' ? 'NOTICE' : 'PRIVMSG';
      this.send(`:${src} ${cmd} ${ev.room} :${text}`);
      return;
    }
    if (!ev.room || ev.room === '*server*') return;
    const inChan = me.channels.has(ev.room) || lower(ev.author) === lower(me.nick);
    if (!inChan && ev.kind !== 'quit') return;
    const src = `${ev.author}!user@hidden`;
    if (ev.kind === 'join') {
      if (lower(ev.author) === lower(me.nick)) return;
      const u = irc.findNick(ev.author);
      this.send(`:${u ? hostmask(u) : src} JOIN ${ev.room}`);
    } else if (ev.kind === 'part') {
      if (lower(ev.author) === lower(me.nick)) return;
      this.send(`:${src} PART ${ev.room} :${ev.text || ''}`);
    }
    else if (ev.kind === 'quit') this.send(`:${src} QUIT :${ev.text || 'Quit'}`);
    else if (ev.kind === 'nick') {
      const neu = ev.extra?.newNick || ev.extra?.extra?.newNick;
      if (neu) this.send(`:${src} NICK :${neu}`);
    } else if (ev.kind === 'kick') this.send(`:${src} KICK ${ev.room} :${ev.text}`);
    else if (ev.kind === 'topic') {
      const ch = state.channels[ev.room];
      if (ch) this.send(`:${src} TOPIC ${ev.room} :${ch.topic || ''}`);
    } else if (ev.kind === 'mode') {
      const spec = ev.text && ev.text.match(/\[([^\]]+)\]/);
      this.send(`:${src} MODE ${ev.room} ${spec ? spec[1] : '+n'}`);
    }
  }

  names(chan) {
    const names = irc.nicklist(chan).map((n) => n.prefix + n.nick).join(' ');
    this.numeric('353', `= ${chan}`, names);
    this.numeric('366', chan, 'End of /NAMES list');
  }

  handle(msg) {
    const { cmd, args } = msg;
    if (cmd === 'CAP') {
      const sub = (args[0] || '').toUpperCase();
      const nick = this.nick || '*';
      if (sub === 'LS') this.send(`:${SERVER} CAP ${nick} LS :multi-prefix`);
      else if (sub === 'REQ') {
        const caps = args.slice(1).join(' ').replace(/^:/, '');
        this.send(`:${SERVER} CAP ${nick} ACK :${caps}`);
      }
      return;
    }
    if (cmd === 'PING') {
      this.send(`:${SERVER} PONG ${SERVER} :${args[0] || SERVER}`);
      return;
    }
    if (cmd === 'PONG') return;
    if (cmd === 'PASS') return;
    if (cmd === 'NICK') {
      const want = args[0];
      if (!want) { this.numeric('431', '', 'No nickname given'); return; }
      if (!this.client) {
        this.nick = want;
        this.gotNick = true;
        this.register();
        return;
      }
      const res = irc.changeNick(this.client, want);
      if (!res.ok) this.numeric('433', want, res.error || 'Nickname is already in use');
      else this.nick = this.client.nick;
      return;
    }
    if (cmd === 'USER') {
      this.ident = (args[0] || 'user').slice(0, 12);
      this.realname = args.slice(3).join(' ') || 'anon';
      this.gotUser = true;
      this.register();
      return;
    }
    if (cmd === 'QUIT') {
      this.drop(args[0] || 'Quit');
      return;
    }
    if (!this.client) {
      this.numeric('451', '', 'You have not registered');
      return;
    }
    const c = this.client;
    if (cmd === 'JOIN') {
      const list = String(args[0] || '').replace(/^:/, '');
      if (list === '0') {
        for (const ch of [...c.channels]) irc.part(c, ch, 'JOIN 0');
        return;
      }
      for (const name of list.split(',')) {
        if (!name) continue;
        const res = irc.join(c, name, args[1]);
        if (!res.ok) {
          this.numeric('403', name, res.error || 'No such channel');
          continue;
        }
        this.confirmJoin(res.switchBuffer || name);
      }
      return;
    }
    if (cmd === 'PART') {
      const res = irc.part(c, args[0], args.slice(1).join(' '));
      if (res.ok) this.send(`:${this.mask()} PART ${args[0]} :${args.slice(1).join(' ') || ''}`);
      return;
    }
    if (cmd === 'PRIVMSG' || cmd === 'NOTICE') {
      const tgt = args[0];
      const text = args.slice(1).join(' ');
      if (!tgt || !text) return;
      const svc = { nickserv: 'NickServ', ns: 'NickServ', chanserv: 'ChanServ', cs: 'ChanServ', memoserv: 'MemoServ', ms: 'MemoServ', operserv: 'OperServ', os: 'OperServ', botserv: 'BotServ', bs: 'BotServ', hostserv: 'HostServ', hs: 'HostServ' }[tgt.toLowerCase()];
      if (svc) {
        const res = handleService(irc, c, [...c.channels][0] || '*server*', svc, text);
        c.pushNotice?.(res.lines || []);
        if (res.error) this.send(`:${svc}!service@services.${SERVER} NOTICE ${this.nick} :${res.error}`);
        else if (res.status) this.send(`:${svc}!service@services.${SERVER} NOTICE ${this.nick} :${res.status}`);
        return;
      }
      let body = text;
      let type = cmd === 'NOTICE' ? 'notice' : 'privmsg';
      if (body.startsWith('\x01ACTION ') && body.endsWith('\x01')) {
        type = 'action';
        body = body.slice(8, -1);
      }
      const res = irc.privmsg(c, tgt, body, type);
      if (!res.ok) this.numeric('404', tgt, res.error || 'Cannot send');
      return;
    }
    if (cmd === 'MODE') {
      const res = irc.mode(c, args[0], args[1], args.slice(2));
      if (res.status) this.numeric('324', args[0], res.status.replace(/^Mode /, ''));
      if (res.error) this.numeric('482', args[0], res.error);
      return;
    }
    if (cmd === 'TOPIC') {
      const res = irc.topic(c, args[0], args.length > 1 ? args.slice(1).join(' ') : null);
      if (res.error) this.numeric('482', args[0], res.error);
      return;
    }
    if (cmd === 'NAMES') {
      this.names(args[0] || [...c.channels][0] || '#lounge');
      return;
    }
    if (cmd === 'WHO') {
      const chan = args[0] || [...c.channels][0];
      if (chan) {
        for (const n of irc.nicklist(chan)) {
          const u = irc.findNick(n.nick);
          this.numeric('352', `${chan} ${u?.ident || 'user'} ${u ? hostmask(u, c).split('@')[1] : '*'} ${SERVER} ${n.nick} H${n.prefix}`, '0 ' + (u?.realname || ''));
        }
      }
      this.numeric('315', args[0] || '', 'End of /WHO list');
      return;
    }
    if (cmd === 'WHOIS') {
      const res = irc.exec(c, [...c.channels][0] || '*server*', '/whois ' + (args[0] || ''));
      for (const line of res.lines || []) this.numeric('311', args[0] || '', line.text);
      this.numeric('318', args[0] || this.nick, 'End of /WHOIS');
      return;
    }
    if (cmd === 'LIST') {
      const a = String(args[0] || '').trim();
      let nameFilt = '';
      if (a.startsWith('#') || (a && !/[<>]/.test(a))) {
        nameFilt = a.replace(/\*/g, '').toLowerCase();
      }
      this.numeric('321', 'Channel', 'Users  Name');
      for (const ch of Object.values(state.channels)) {
        if (!ch?.name || !ch.name.startsWith('#')) continue;
        if (ch.modes?.s && !c.channels.has(ch.name) && !c.oper) continue;
        if (nameFilt && !ch.name.toLowerCase().includes(nameFilt)) continue;
        const n = irc.members(ch.name).length;
        const topic = String(ch.topic || ' ')
          .replace(/[\u2010-\u2015]/g, '-')
          .replace(/[^\x20-\x7e]/g, ' ')
          .trim() || ' ';
        this.numeric('322', `${ch.name} ${n}`, topic);
      }
      this.numeric('323', '', 'End of /LIST');
      return;
    }
    if (cmd === 'AWAY') {
      irc.exec(c, '*server*', '/away ' + args.join(' '));
      return;
    }
    if (cmd === 'KICK') {
      const res = irc.kick(c, args[0], args[1], args.slice(2).join(' '));
      if (res.error) this.numeric('482', args[0], res.error);
      return;
    }
    if (cmd === 'INVITE') {
      irc.invite(c, args[0], args[1]);
      return;
    }
    if (cmd === 'MOTD') {
      for (const line of (state.settings.motd || [])) this.numeric('372', '', '- ' + line);
      this.numeric('376', '', 'End of /MOTD command');
      return;
    }
    if (cmd === 'LUSERS') {
      this.numeric('251', '', `There are ${irc.humanCount()} users on 1 server`);
      return;
    }
    this.numeric('421', cmd, 'Unknown command');
  }
}

function lower(s) {
  return String(s || '').toLowerCase();
}

export function startIrcTls(port = 6697) {
  if (!port) return null;
  let tlsOpts;
  try {
    tlsOpts = ensureTls();
  } catch (err) {
    console.error('[IRCS] TLS cert failed:', err.message);
    return null;
  }
  const server = tls.createServer(tlsOpts, (socket) => {
    socket.write('');
    new IrcWire(socket);
  });
  server.on('error', (err) => console.error('[IRCS]', err.message));
  server.listen(port, '0.0.0.0', () => {
    console.log(`[IRCS] TLS IRC on 0.0.0.0:${port}`);
  });
  return server;
}
