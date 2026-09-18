import crypto from 'crypto';
import { state, normalizeChannel, isValidNick, verifyPassword, normalizeChanRecord } from './state.js';
import { handleService, flagRank, splitArgs } from './services.js';

const RESERVED = new Set(['nickserv', 'chanserv', 'operserv', 'memoserv', 'botserv', 'hostserv', 'shrc', 'server', '*server*', 'admin']);
const FLOOD_WINDOW_MS = 5000;
const FLOOD_MAX = 8;
const ENFORCE_MS = 30000;
function defaultMotd() {
  return [
    'welcome to shrc',
    'guests are Guest######. ssh Frank@host claims Frank.',
    'your key or web id auto-identifies a nick bound to it.',
    'else /nick then /identify (30 seconds) or you get renamed.',
    'services: /ns /cs /ms /os /bs /hs   /watch  /ignore',
    '/cs register  to keep founder/op/voice across reconnects.',
    '/help for the rest.  /quit or Ctrl+C to leave.'
  ];
}

function currentMotd() {
  const lines = state.settings?.motd;
  return Array.isArray(lines) && lines.length ? lines : defaultMotd();
}

function lower(s) {
  return String(s || '').toLowerCase();
}

function globToRegExp(glob) {
  const esc = String(glob || '')
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

function identFromFp(fp) {
  const cleaned = String(fp || 'anon').replace(/[^A-Za-z0-9]/g, '');
  return (cleaned.slice(-12) || 'anon').slice(0, 12);
}

export function isSshKeyFingerprint(fp) {
  return String(fp || '').startsWith('SHA256:');
}

export function isStickyFingerprint(fp) {
  const s = String(fp || '');
  if (isSshKeyFingerprint(s)) return true;
  return /^web:[0-9a-f]{16,}$/i.test(s);
}

function cloakHost(client) {
  if (client?.isBot) return client.ip || 'services.shrc';
  if (client?.identified) {
    const acc = state.getAccount(client.account);
    if (acc?.vhost && acc.vhostOn !== false) return acc.vhost;
  }
  const src = String(client?.ip || '0') + '\0' + String(client?.fingerprint || '');
  const h = crypto.createHash('sha256').update(src).digest('hex').slice(0, 10);
  return `${h}.users.shrc`;
}

export function hostmask(client, viewer) {
  const showReal = !!(viewer && viewer.oper && !client?.isBot);
  const host = showReal ? (client.ip || '0.0.0.0') : cloakHost(client);
  return `${client.nick}!${client.ident}@${host}`;
}

function matchMask(mask, client) {
  const m = lower(mask);
  if (!m) return false;
  if (m === lower(client.nick) || m === lower(client.fingerprint) || m === lower(client.ip)) return true;
  const cloaked = hostmask(client);
  const real = `${client.nick}!${client.ident}@${client.ip || '0.0.0.0'}`;
  try {
    const re = globToRegExp(m);
    return re.test(cloaked) || re.test(real) || re.test(cloakHost(client))
      || re.test(client.nick) || re.test(client.ip || '') || re.test(client.fingerprint || '');
  } catch {
    return false;
  }
}

function sanitize(text, max = 400) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x01\x04-\x08\x0b\x0c\x0e\x10-\x15\x17-\x1c\x1e]/g, '')
    .replace(/\r\n|\n|\r/g, ' ')
    .slice(0, max);
}

function ok(extra = {}) {
  return { ok: true, error: null, status: extra.status || '', lines: extra.lines || [], switchBuffer: extra.switchBuffer || null, quit: false, reason: extra.reason || '', openQuery: extra.openQuery || null };
}

function fail(error) {
  return { ok: false, error, status: '', lines: [], switchBuffer: null, quit: false, reason: '', openQuery: null };
}

function infoLines(lines) {
  return ok({
    lines: lines.map((text) => ({
      type: 'server',
      author: 'shrc',
      text,
      timestamp: Date.now()
    }))
  });
}

function pmRoom(a, b) {
  const [x, y] = [lower(a), lower(b)].sort();
  return `query:${x}:${y}`;
}

export function queryPeer(room, myNick) {
  if (!String(room).startsWith('query:')) return null;
  const parts = room.slice(6).split(':');
  const me = lower(myNick);
  return parts.find((p) => p !== me) || parts[0] || null;
}

export class IrcNetwork {
  constructor() {
    this.clients = new Map();
    this.nicks = new Map();
    this.invites = new Map();
    this.flood = new Map();
  }

  allocGuest() {
    let nick;
    do {
      nick = 'Guest' + String(crypto.randomInt(100000, 1000000));
    } while (this.nicks.has(lower(nick)));
    return nick;
  }

  guestNick(requested) {
    if (!isValidNick(requested) || RESERVED.has(lower(requested))) {
      return this.allocGuest();
    }
    let nick = requested.slice(0, 16);
    let i = 0;
    while (this.nicks.has(lower(nick)) || RESERVED.has(lower(nick))) {
      i += 1;
      nick = (requested.slice(0, 12) + i).slice(0, 16);
    }
    return nick;
  }

  clearEnforce(client) {
    if (client?.enforceTimer) {
      clearTimeout(client.enforceTimer);
      client.enforceTimer = null;
    }
  }

  nickServLines() {
    return [
      'This nickname is registered and protected. If it is your',
      'nick, type /identify <password>. Otherwise, please choose',
      'a different nick.',
      'You have 30 seconds to identify to your nickname before it is changed.'
    ].map((text) => ({ type: 'notice', author: 'NickServ', text, timestamp: Date.now() }));
  }

  pushNickServ(client, lines) {
    this.pushServiceLines(client, lines);
  }

  pushServiceLines(client, lines) {
    if (typeof client.pushNotice === 'function') {
      try { client.pushNotice(lines); } catch {}
    }
  }

  pushService(client, service, texts) {
    this.pushServiceLines(client, texts.map((text) => ({
      type: 'notice',
      author: service,
      text,
      timestamp: Date.now()
    })));
  }

  accountByFingerprint(fingerprint) {
    const fp = String(fingerprint || '');
    if (!isStickyFingerprint(fp)) return null;
    const hits = Object.values(state.accounts).filter((a) => a.fingerprint === fp);
    if (!hits.length) return null;
    return hits.sort((a, b) => (a.registeredAt || 0) - (b.registeredAt || 0))[0];
  }

  syncEnforce(client) {
    const owns = client.identified && lower(client.account) === lower(client.nick);
    if (!state.isNickProtected(client.nick) || owns) {
      this.clearEnforce(client);
      return [];
    }
    this.clearEnforce(client);
    client.enforceTimer = setTimeout(() => this.enforceTimeout(client), ENFORCE_MS);
    return this.nickServLines();
  }

  enforceTimeout(client) {
    if (!this.clients.has(client.id)) return;
    if (client.identified && lower(client.account) === lower(client.nick)) return;
    if (!state.isNickProtected(client.nick)) return;
    const old = client.nick;
    const guest = this.allocGuest();
    this._applyNick(client, guest, { remapModes: false });
    this.pushNickServ(client, [
      { type: 'notice', author: 'NickServ', text: `Your nickname is now ${guest}.`, timestamp: Date.now() },
      { type: 'notice', author: 'NickServ', text: `${old} is registered. /nick ${old} then /identify <password>.`, timestamp: Date.now() }
    ]);
    state.onChange();
  }

  checkBan({ fingerprint, ip, nick }) {
    const fp = lower(fingerprint);
    const ipL = lower(ip);
    const nickL = lower(nick);
    return state.serverBans.find((b) => {
      if (b.type === 'fingerprint' && b.value === fp) return true;
      if (b.type === 'ip' && b.value === ipL) return true;
      if (b.type === 'nick' && b.value === nickL) return true;
      return false;
    }) || null;
  }

  connect({ id, nick, fingerprint, ip, onKill }) {
    const ban = this.checkBan({ fingerprint, ip, nick });
    if (ban) {
      return { banned: true, ban };
    }

    const fp = fingerprint || 'anon:' + crypto.randomBytes(4).toString('hex');
    const bound = this.accountByFingerprint(fp);
    const remembered = (!bound && fp.startsWith('web:') && state.webNicks[fp]) ? state.webNicks[fp] : null;

    const client = {
      id,
      nick: this.guestNick(bound ? bound.nickname : (nick || remembered)),
      fingerprint: fp,
      ip: ip || '0.0.0.0',
      ident: identFromFp(fp),
      realname: 'anon',
      channels: new Set(),
      queries: new Set(),
      identified: false,
      account: null,
      oper: false,
      away: null,
      ignores: new Set(),
      watch: new Set(),
      connectedAt: Date.now(),
      lastActive: Date.now(),
      onKill: typeof onKill === 'function' ? onKill : () => {}
    };

    const extraNotices = [];
    if (bound) {
      const taken = this.nicks.get(lower(bound.nickname));
      if (taken && taken.fingerprint === fp) {
        taken.onKill('Replaced by a new session with the same SSH key');
        this.disconnect(taken.id, 'Replaced (same SSH key)');
        client.nick = this.guestNick(bound.nickname);
      } else if (taken) {
        extraNotices.push({
          type: 'notice',
          author: 'NickServ',
          text: `${bound.nickname} is in use. /ns ghost ${bound.nickname} <password> or wait.`,
          timestamp: Date.now()
        });
      } else {
        client.nick = bound.nickname;
        client.identified = true;
        client.account = bound.nickname;
        client.oper = !!bound.isOper;
        extraNotices.push({
          type: 'notice',
          author: 'NickServ',
          text: `Identity recognized. You are identified as ${bound.nickname}.`,
          timestamp: Date.now()
        });
      }
    } else if (nick && state.isNickProtected(nick) && isSshKeyFingerprint(fp)) {
      extraNotices.push({
        type: 'notice',
        author: 'NickServ',
        text: `${nick} is registered. /identify <password> to bind this SSH key for next time.`,
        timestamp: Date.now()
      });
    }

    client.ident = identFromFp(client.fingerprint);
    this.clients.set(id, client);
    this.nicks.set(lower(client.nick), client);
    state.stats.activeUsers = this.humanCount();
    state.stats.totalConnections++;
    state.scheduleSave();
    const nickserv = client.identified ? extraNotices : extraNotices.concat(this.syncEnforce(client));
    if (client.identified) this.loadAccountPrefs(client);
    this.notifyWatchers(client, true);
    return { banned: false, client, motd: currentMotd(), nickserv };
  }

  loadAccountPrefs(client) {
    const acc = state.getAccount(client.account);
    if (!acc) return;
    client.ignores = new Set((acc.ignores || []).map(lower));
    client.watch = new Set((acc.watch || []).map(lower));
  }

  persistPrefs(client) {
    if (!client.identified) return;
    const acc = state.getAccount(client.account);
    if (!acc) return;
    acc.ignores = [...(client.ignores || [])];
    acc.watch = [...(client.watch || [])];
    state.scheduleSave();
  }

  notifyWatchers(client, online) {
    if (client.isBot) return;
    const nick = lower(client.nick);
    const accName = client.account ? lower(client.account) : nick;
    for (const other of this.clients.values()) {
      if (other === client || other.isBot) continue;
      const watched = other.watch instanceof Set
        ? other.watch
        : new Set();
      if (!watched.has(nick) && !watched.has(accName)) continue;
      this.pushService(other, 'NickServ', [
        online
          ? `${client.nick} is online.`
          : `${client.nick} is offline (${client.away || 'quit'}).`
      ]);
    }
  }

  opsLog(text) {
    state.ensureChannel('#ops');
    const ch = state.channels['#ops'];
    ch.registered = true;
    ch.modes.n = true;
    ch.modes.t = true;
    state.addChatMessage('#ops', 'OperServ', 'bot:operserv', text, { type: 'notice' });
  }

  disconnect(id, reason = 'Quit') {
    const client = this.clients.get(id);
    if (!client) return;
    this.notifyWatchers(client, false);
    if (String(client.fingerprint).startsWith('web:') && client.nick) {
      state.webNicks[client.fingerprint] = client.nick;
      state.scheduleSave();
    }
    this.clearEnforce(client);
    const chans = [...client.channels];
    for (const ch of chans) {
      this._part(client, ch, reason, 'quit');
    }
    this.clients.delete(id);
    if (this.nicks.get(lower(client.nick)) === client) {
      this.nicks.delete(lower(client.nick));
    }
    this.flood.delete(id);
    state.stats.activeUsers = this.humanCount();
    state.scheduleSave();
    state.onChange();
  }

  get(id) {
    return this.clients.get(id) || null;
  }

  findNick(nick) {
    return this.nicks.get(lower(nick)) || null;
  }

  members(channel) {
    const key = normalizeChannel(channel);
    const list = [];
    for (const c of this.clients.values()) {
      if (c.channels.has(key)) list.push(c);
    }
    return list;
  }

  accessRank(client, channel) {
    if (client.oper) return 100;
    const ch = state.channels[normalizeChannel(channel)];
    if (!ch) return 0;
    const nick = lower(client.identified ? client.account || client.nick : client.nick);
    if (ch.registered && ch.settings?.secure && !client.identified) return 0;
    return flagRank(ch.flags?.[nick]);
  }

  isFounder(client, channel) {
    if (client.oper) return true;
    const ch = state.channels[normalizeChannel(channel)];
    if (!ch) return false;
    return client.identified && ch.founder === lower(client.account || client.nick);
  }

  isOp(client, channel) {
    if (client.oper) return true;
    const ch = state.channels[normalizeChannel(channel)];
    if (!ch) return false;
    const ln = lower(client.nick);
    if (ch.ops.includes(ln) || (ch.admins || []).includes(ln)) return true;
    if (state.isNickProtected(client.nick) && !client.identified) return false;
    return this.accessRank(client, channel) >= 30;
  }

  isHalfop(client, channel) {
    if (this.isOp(client, channel)) return true;
    const ch = state.channels[normalizeChannel(channel)];
    if (!ch) return false;
    if ((ch.halfops || []).includes(lower(client.nick))) return true;
    if (state.isNickProtected(client.nick) && !client.identified) return false;
    return this.accessRank(client, channel) >= 20;
  }

  isVoice(client, channel) {
    if (this.isHalfop(client, channel)) return true;
    const ch = state.channels[normalizeChannel(channel)];
    if (!ch) return false;
    if (ch.voices.includes(lower(client.nick))) return true;
    if (state.isNickProtected(client.nick) && !client.identified) return false;
    return this.accessRank(client, channel) >= 10;
  }

  prefix(client, channel) {
    const key = normalizeChannel(channel);
    const ch = state.channels[key];
    const ln = lower(client.nick);
    if (this.isFounder(client, key) || (ch && ch.founder === ln && client.identified)) return '~';
    if ((ch && (ch.admins || []).includes(ln)) || this.accessRank(client, key) >= 40) return '&';
    if (this.isOp(client, key)) return '@';
    if (this.isHalfop(client, key) && !this.isOp(client, key)) return '%';
    if (this.isVoice(client, key)) return '+';
    return '';
  }

  setLive(ch, nickLower, letter, give) {
    const map = { o: 'ops', v: 'voices', h: 'halfops', a: 'admins' };
    const arr = map[letter];
    if (!arr || !ch) return;
    if (!ch[arr]) ch[arr] = [];
    const ln = lower(nickLower);
    if (give) {
      if (!ch[arr].includes(ln)) ch[arr].push(ln);
    } else {
      ch[arr] = ch[arr].filter((n) => n !== ln);
    }
  }

  mutateFlags(ch, nickLower, spec) {
    const ln = lower(nickLower);
    let cur = ch.flags[ln] || '';
    let adding = String(spec).startsWith('-') ? false : true;
    for (const c of String(spec).toUpperCase()) {
      if (c === '+') { adding = true; continue; }
      if (c === '-') { adding = false; continue; }
      if (!'FAOHV'.includes(c)) continue;
      if (adding) {
        if (!cur.includes(c)) cur += c;
      } else {
        cur = cur.split(c).join('');
      }
    }
    if (cur) ch.flags[ln] = cur;
    else delete ch.flags[ln];
    return cur;
  }

  announceMode(channel, by, spec, fingerprint) {
    this._announce(channel, 'mode', by, `mode/${channel} [${spec}] by ${by}`, { fingerprint: fingerprint || 'shrc' });
  }

  applyAccess(client, channel) {
    const key = normalizeChannel(channel);
    const ch = state.ensureChannel(key);
    if (!ch.registered) return;
    if (ch.settings.secure && !client.identified) return;
    const ln = lower(client.identified ? client.account || client.nick : client.nick);
    const flags = ch.flags[ln] || '';
    if (flags.includes('F') || flags.includes('A')) this.setLive(ch, ln, 'a', true);
    if (flags.includes('F') || flags.includes('A') || flags.includes('O')) this.setLive(ch, ln, 'o', true);
    if (flags.includes('H')) this.setLive(ch, ln, 'h', true);
    if (flags.includes('V')) this.setLive(ch, ln, 'v', true);
    if (flags.includes('F')) ch.founder = ln;
  }

  setFlags(client, channel, nick, spec) {
    const key = normalizeChannel(channel);
    const ch = state.ensureChannel(key);
    if (!ch.registered) return fail('Channel is not registered. /cs register first.');
    const my = this.accessRank(client, key);
    if (my < 40 && !client.oper) return fail('You need SOP/founder (A/F) to edit flags.');
    const ln = lower(nick);
    if (!isValidNick(nick) && !ln) return fail('Invalid nick.');
    const target = this.findNick(nick);
    const live = [];
    const letter = { F: 'a', A: 'a', O: 'o', H: 'h', V: 'v' };
    let adding = String(spec).startsWith('-') ? false : true;
    let cur = ch.flags[ln] || '';
    for (const c of String(spec).toUpperCase()) {
      if (c === '+') { adding = true; continue; }
      if (c === '-') { adding = false; continue; }
      if (!'FAOHV'.includes(c)) continue;
      const need = c === 'F' ? 50 : c === 'A' ? 50 : 40;
      if (my < need && !client.oper) continue;
      if (c === 'F' && !client.oper && ch.founder !== lower(client.account)) continue;
      if (adding) {
        if (!cur.includes(c)) cur += c;
      } else {
        cur = cur.split(c).join('');
        if (c === 'F' && ch.founder === ln) ch.founder = lower(client.account || '');
      }
      const mode = letter[c];
      if (mode) {
        if (target && target.channels.has(key)) this.setLive(ch, ln, mode, adding);
        live.push((adding ? '+' : '-') + mode + ' ' + (target ? target.nick : nick));
      }
    }
    if (cur) ch.flags[ln] = cur;
    else delete ch.flags[ln];
    if (live.length) this.announceMode(key, client.nick, live.join(' '), client.fingerprint);
    else this.announceMode(key, client.nick, `${spec} ${nick}`, client.fingerprint);
    state.onChange();
    return ok({ status: `${nick} flags on ${key}: +${ch.flags[ln] || '(none)'}` });
  }

  nicklist(channel) {
    const key = normalizeChannel(channel);
    const list = this.members(key).map((c) => ({
      nick: c.nick,
      prefix: this.prefix(c, key),
      away: !!c.away,
      oper: c.oper,
      identified: c.identified
    }));
    list.sort((a, b) => {
      const rank = (p) => ({ '~': 0, '&': 1, '@': 2, '%': 3, '+': 4 }[p] ?? 5);
      const r = rank(a.prefix) - rank(b.prefix);
      if (r !== 0) return r;
      return a.nick.localeCompare(b.nick);
    });
    return list;
  }

  humanCount() {
    let n = 0;
    for (const c of this.clients.values()) if (!c.isBot) n++;
    return n;
  }

  occupiedChannelCount() {
    const names = new Set();
    for (const c of this.clients.values()) {
      if (c.isBot) continue;
      for (const ch of c.channels) names.add(ch);
    }
    return names.size;
  }

  spawnBot(def) {
    const nick = def.nick;
    const existing = this.findNick(nick);
    if (existing) {
      if (existing.isBot) return existing;
      return null;
    }
    const client = {
      id: 'bot-' + lower(nick),
      nick,
      fingerprint: 'bot:' + lower(nick),
      ip: def.host || 'services.shrc',
      ident: def.ident || 'bot',
      realname: def.realname || 'bot',
      channels: new Set(),
      queries: new Set(),
      identified: true,
      account: nick,
      oper: false,
      isBot: true,
      away: null,
      ignores: new Set(),
      connectedAt: Date.now(),
      lastActive: Date.now(),
      onKill: () => {}
    };
    this.clients.set(client.id, client);
    this.nicks.set(lower(nick), client);
    return client;
  }

  botJoin(bot, channel, quiet = false) {
    const key = normalizeChannel(channel);
    const ch = state.ensureChannel(key);
    if (bot.channels.has(key)) return;
    bot.channels.add(key);
    if (!ch.ops.includes(lower(bot.nick))) ch.ops.push(lower(bot.nick));
    if (!quiet) {
      this._announce(key, 'join', bot.nick, `${bot.nick} [${bot.ident}@${bot.ip}] has joined ${key}`, {
        fingerprint: bot.fingerprint
      });
    }
  }

  botPart(bot, channel) {
    const key = normalizeChannel(channel);
    if (!bot.channels.has(key)) return;
    bot.channels.delete(key);
    const ch = state.channels[key];
    if (ch) {
      ch.ops = (ch.ops || []).filter((n) => n !== lower(bot.nick));
    }
    this._announce(key, 'part', bot.nick, `${bot.nick} has left ${key} (unassigned)`, { fingerprint: bot.fingerprint });
  }

  botSpeak(channel, text, type = 'privmsg') {
    const key = normalizeChannel(channel);
    const ch = state.channels[key];
    const botName = ch?.botserv?.bot;
    if (!botName) return fail('No bot assigned to that channel.');
    const bot = this.findNick(botName);
    if (!bot || !bot.isBot) return fail('Bot is not online.');
    state.addChatMessage(key, bot.nick, bot.fingerprint, sanitize(text, 400), { type });
    return ok({ status: 'Said.' });
  }

  bootBots() {
    if (!state.bots.HelpBot) {
      state.bots.HelpBot = {
        nick: 'HelpBot',
        ident: 'bot',
        host: 'services.shrc',
        realname: 'a helpful robot',
        createdBy: 'shrc'
      };
    }
    for (const def of Object.values(state.bots)) {
      this.spawnBot(def);
    }
    for (const ch of Object.values(state.channels)) {
      const name = ch.botserv?.bot;
      if (!name) continue;
      const bot = this.findNick(name);
      if (bot && bot.isBot) this.botJoin(bot, ch.name, true);
    }
    state.stats.activeUsers = this.humanCount();
  }

  handleFantasy(client, channel, body) {
    const ch = state.channels[channel];
    if (!ch?.botserv?.bot || ch.botserv.fantasy === false) return;
    if (client.isBot) return;
    const bot = this.findNick(ch.botserv.bot);
    if (!bot || !bot.isBot) return;
    const parsed = splitArgs(body.slice(1));
    const cmd = parsed.cmd;
    const args = parsed.args;
    const targetNick = args[0] || client.nick;
    const asBotNotice = (text) => {
      state.addChatMessage(channel, bot.nick, bot.fingerprint, text, { type: 'notice' });
    };

    const need = (rank) => {
      if (this.accessRank(client, channel) >= rank || client.oper) return true;
      asBotNotice(`${client.nick}: permission denied.`);
      return false;
    };

    const protectedKick = (who) => {
      const t = this.findNick(who);
      if (!t) return false;
      if (t.isBot) return true;
      if (ch.botserv.dontkickops && this.isOp(t, channel)) return true;
      if (ch.botserv.dontkickvoices && this.isVoice(t, channel) && !this.isOp(t, channel)) return true;
      return false;
    };

    switch (cmd) {
      case 'op':
        if (!need(30)) return;
        this.setOp(client, channel, targetNick, true);
        return;
      case 'deop':
        if (!need(40)) return;
        this.setOp(client, channel, targetNick, false);
        return;
      case 'voice':
        if (!need(30)) return;
        this.setVoice(client, channel, targetNick, true);
        return;
      case 'devoice':
        if (!need(30)) return;
        this.setVoice(client, channel, targetNick, false);
        return;
      case 'hop':
      case 'halfop':
        if (!need(40)) return;
        this.setHop(client, channel, targetNick, true);
        return;
      case 'kick':
        if (!need(30)) return;
        if (protectedKick(targetNick)) {
          asBotNotice(this.findNick(targetNick)?.isBot
            ? 'I will not kick a service bot. Use /bs unassign.'
            : 'I will not kick that user.');
          return;
        }
        this.kick(client, channel, targetNick, args.slice(1).join(' ') || 'fantasy kick');
        return;
      case 'ban':
        if (!need(30)) return;
        this.ban(client, channel, targetNick, args.slice(1).join(' '), true);
        return;
      case 'unban':
        if (!need(30)) return;
        this.ban(client, channel, targetNick, '', false);
        return;
      case 'topic':
        if (!need(30)) return;
        this.topic(client, channel, parsed.rest);
        return;
      case 'access': {
        if (!need(40)) return;
        const sub = (args[0] || '').toLowerCase();
        const res = handleService(this, client, channel, 'ChanServ',
          sub ? `ACCESS ${channel} ${parsed.rest}` : `ACCESS ${channel} LIST`);
        for (const line of res.lines || []) {
          asBotNotice(line.text);
        }
        if (res.error) asBotNotice(res.error);
        else if (res.status) asBotNotice(res.status);
        return;
      }
      case 'assign':
      case 'unassign':
        asBotNotice('Use /bs ASSIGN or /bs UNASSIGN.');
        return;
      default:
        return;
    }
  }

  buffers(client) {
    const out = ['*server*', ...[...client.channels].sort()];
    for (const q of [...client.queries].sort()) out.push('query:' + [lower(client.nick), lower(q)].sort().join(':'));
    return out;
  }

  _announce(channel, type, author, text, extra = {}) {
    state.addChatMessage(channel, author, extra.fingerprint || 'shrc', text, { type, extra });
  }

  _channelBanHit(ch, client) {
    return (ch.bans || []).some((b) => matchMask(b.mask, client));
  }

  join(client, rawName, key) {
    const channel = normalizeChannel(rawName);
    if (channel.length < 2) return fail('Invalid channel name.');
    const existed = !!state.channels[channel];
    const ch = state.ensureChannel(channel, existed ? 'shrc' : client.nick);
    if (client.channels.has(channel)) {
      return ok({ switchBuffer: channel, status: `Already in ${channel}` });
    }
    if (ch.modes.k && ch.modes.k !== (key || '')) {
      return fail(`${channel}: cannot join (need +k key). Use /join ${channel} <key>`);
    }
    if (ch.modes.l && this.members(channel).length >= ch.modes.l) {
      return fail(`${channel}: cannot join (channel is full).`);
    }
    if (ch.modes.i) {
      const invited = (this.invites.get(channel) || new Set()).has(lower(client.nick));
      if (!invited && !client.oper) return fail(`${channel}: cannot join (invite only).`);
    }
    if (this._channelBanHit(ch, client) && !client.oper) {
      return fail(`${channel}: cannot join (banned).`);
    }
    if (ch.registered && (ch.akick || []).some((a) => matchMask(a.mask, client)) && !client.oper) {
      return fail(`${channel}: cannot join (akick).`);
    }
    if (ch.registered && ch.settings.restricted && this.accessRank(client, channel) < 10 && !client.oper) {
      const invited = (this.invites.get(channel) || new Set()).has(lower(client.nick));
      if (!invited) return fail(`${channel}: cannot join (restricted).`);
    }

    client.channels.add(channel);

    if (!existed && !ch.registered) {
      if (!ch.ops.includes(lower(client.nick))) ch.ops.push(lower(client.nick));
      ch.founder = lower(client.nick);
    }

    this.applyAccess(client, channel);

    const inv = this.invites.get(channel);
    if (inv) inv.delete(lower(client.nick));

    this._announce(channel, 'join', client.nick, `${client.nick} [${hostmask(client)}] has joined ${channel}`, {
      fingerprint: client.fingerprint
    });
    state.scheduleSave();

    const extra = [];
    const topicLine = ch.topic
      ? `Topic for ${channel}: ${ch.topic} (set by ${ch.topicBy})`
      : `No topic is set for ${channel}`;
    extra.push({ type: 'server', author: 'shrc', text: topicLine, timestamp: Date.now() });
    extra.push({ type: 'server', author: 'shrc', text: `Names: ${this.nicklist(channel).map((n) => n.prefix + n.nick).join(' ')}`, timestamp: Date.now() });
    if (ch.registered && ch.settings.entrymsg) {
      extra.push({ type: 'notice', author: 'ChanServ', text: `[${channel}] ${ch.settings.entrymsg}`, timestamp: Date.now() });
    }
    if (!client.isBot && ch.botserv?.bot && ch.botserv.greet) {
      const greet = String(ch.botserv.greet).replace(/%n/g, client.nick).replace(/%c/g, channel);
      this.botSpeak(channel, greet);
    }
    this.rememberChannel(client, channel, true);
    return ok({
      switchBuffer: channel,
      status: `Joined ${channel}`,
      lines: extra
    });
  }

  rememberChannel(client, channel, joined) {
    if (!client || client.isBot || !client.identified) return;
    const acc = state.getAccount(client.account);
    if (!acc) return;
    if (!acc.ajoin) acc.ajoin = [];
    const ch = normalizeChannel(channel);
    if (!ch.startsWith('#') || ch === '*server*') return;
    if (joined) {
      if (!acc.ajoin.includes(ch)) acc.ajoin.push(ch);
    } else {
      acc.ajoin = acc.ajoin.filter((c) => c !== ch);
    }
    state.scheduleSave();
  }

  autoJoinChannels(client) {
    const acc = client.identified ? state.getAccount(client.account) : null;
    const list = (acc?.ajoin && acc.ajoin.length) ? [...acc.ajoin] : ['#lounge'];
    const results = [];
    for (const ch of list) {
      if (!client.channels.has(normalizeChannel(ch))) {
        results.push(this.join(client, ch));
      }
    }
    if (!client.channels.size) results.push(this.join(client, '#lounge'));
    return results;
  }

  _part(client, channel, reason, kind = 'part') {
    const key = normalizeChannel(channel);
    if (!client.channels.has(key)) return;
    client.channels.delete(key);
    if (kind === 'part') this.rememberChannel(client, key, false);
    const text = kind === 'quit'
      ? `${client.nick} has quit (${sanitize(reason, 80) || 'Quit'})`
      : `${client.nick} has left ${key} (${sanitize(reason, 80) || 'Part'})`;
    this._announce(key, kind, client.nick, text, { fingerprint: client.fingerprint });
    if (this.members(key).length === 0 && !['#lounge', '#linux', '#dev', '#general', '#random'].includes(key)) {
      // keep history; drop live ops except founder
    }
  }

  part(client, rawName, reason) {
    const channel = normalizeChannel(rawName);
    if (!client.channels.has(channel)) return fail(`You're not on ${channel}`);
    this._part(client, channel, reason, 'part');
    const next = [...client.channels][0] || '*server*';
    return ok({ switchBuffer: next, status: `Left ${channel}` });
  }

  _applyNick(client, newNick, { remapModes = true } = {}) {
    const old = client.nick;
    if (lower(old) === lower(newNick) && old === newNick) return old;
    this.nicks.delete(lower(old));
    client.nick = newNick;
    this.nicks.set(lower(newNick), client);

    if (client.identified && lower(client.account) !== lower(newNick)) {
      client.identified = false;
      client.account = null;
      client.oper = false;
    }

    const steal = state.isNickProtected(newNick) && !(client.identified && lower(client.account) === lower(newNick));
    for (const ch of client.channels) {
      const chan = state.channels[ch];
      if (chan && remapModes && !steal) {
        chan.ops = chan.ops.map((n) => (n === lower(old) ? lower(newNick) : n));
        chan.voices = chan.voices.map((n) => (n === lower(old) ? lower(newNick) : n));
      }
      this._announce(ch, 'nick', old, `${old} is now known as ${newNick}`, { fingerprint: client.fingerprint, extra: { newNick } });
    }
    return old;
  }

  changeNick(client, newNick) {
    if (!isValidNick(newNick) || RESERVED.has(lower(newNick))) {
      return fail('Erroneous nickname. 1-16 chars, start with a letter.');
    }
    if (lower(newNick) === lower(client.nick)) {
      client.nick = newNick;
      const lines = this.syncEnforce(client);
      return ok({ status: `Nick is ${newNick}`, lines });
    }
    const taken = this.nicks.get(lower(newNick));
    if (taken && taken !== client) return fail('Nickname is already in use.');

    const ban = this.checkBan({ fingerprint: client.fingerprint, ip: client.ip, nick: newNick });
    if (ban) return fail(`That nick is k-lined (${ban.reason}).`);

    this._applyNick(client, newNick);
    const lines = this.syncEnforce(client);
    state.onChange();
    return ok({
      status: lines.length
        ? `You are now known as ${newNick}. Identify in 30 seconds or you will be renamed.`
        : `You are now known as ${newNick}`,
      lines
    });
  }

  _canSpeak(client, channel) {
    const key = normalizeChannel(channel);
    const ch = state.channels[key];
    if (!ch) return 'No such channel.';
    if (ch.modes.n && !client.channels.has(key)) return `Cannot send to ${key} (you're not in it).`;
    if (this._channelBanHit(ch, client) && !this.isOp(client, key)) return `Cannot send to ${key} (banned).`;
    if (ch.modes.m && !this.isOp(client, key) && !this.isVoice(client, key)) {
      return `Cannot send to ${key} (+m, need voice or op).`;
    }
    return null;
  }

  _flooded(client) {
    const now = Date.now();
    const arr = this.flood.get(client.id) || [];
    const recent = arr.filter((t) => now - t < FLOOD_WINDOW_MS);
    recent.push(now);
    this.flood.set(client.id, recent);
    return recent.length > FLOOD_MAX;
  }

  privmsg(client, target, text, type = 'privmsg') {
    const body = sanitize(text);
    if (!body) return fail('Empty message.');
    if (!client.isBot && this._flooded(client)) return fail('Slow down — flood protection.');
    client.lastActive = Date.now();

    if (target.startsWith('query:') || (target[0] !== '#' && target !== '*server*')) {
      const destNick = target.startsWith('query:') ? queryPeer(target, client.nick) : target;
      const dest = this.findNick(destNick);
      if (!dest) {
        if (state.isNickProtected(destNick) && type === 'privmsg') {
          state.addMemo(destNick, client.nick, body);
          const room = pmRoom(client.nick, destNick);
          client.queries.add(destNick);
          state.addChatMessage(room, client.nick, client.fingerprint, body, { type });
          return ok({
            openQuery: destNick,
            switchBuffer: room,
            status: `${destNick} is offline. Memo sent (they will see it after /identify).`
          });
        }
        return fail(`No such nick: ${destNick}`);
      }
      if (dest.ignores.has(lower(client.nick))) return ok({ status: 'Message sent.' });
      const room = pmRoom(client.nick, dest.nick);
      client.queries.add(dest.nick);
      dest.queries.add(client.nick);
      state.addChatMessage(room, client.nick, client.fingerprint, body, { type });
      return ok({ openQuery: dest.nick, switchBuffer: room });
    }

    const channel = normalizeChannel(target);
    const err = this._canSpeak(client, channel);
    if (err) return fail(err);
    if (!client.isBot && state.isNickProtected(client.nick) && !client.identified) {
      return fail(`Nick '${client.nick}' is registered. /identify <password> to speak.`);
    }
    state.addChatMessage(channel, client.nick, client.fingerprint, body, {
      type,
      extra: { prefix: this.prefix(client, channel) }
    });
    if (type === 'privmsg' && /^\.[A-Za-z]/.test(body)) this.handleFantasy(client, channel, body);
    return ok();
  }

  topic(client, channel, newTopic) {
    const key = normalizeChannel(channel);
    const ch = state.channels[key];
    if (!ch) return fail('No such channel.');
    if (newTopic == null) {
      return ok({
        status: ch.topic ? `Topic for ${key}: ${ch.topic}` : `No topic is set for ${key}`
      });
    }
    if (ch.modes.t && !this.isOp(client, key)) return fail(`You're not a channel operator on ${key}.`);
    ch.topic = sanitize(newTopic, 200);
    ch.topicBy = client.nick;
    ch.topicAt = Date.now();
    this._announce(key, 'topic', client.nick, `${client.nick} changed the topic to: ${ch.topic}`, {
      fingerprint: client.fingerprint
    });
    state.onChange();
    return ok({ status: `Topic for ${key} updated.` });
  }

  kick(client, channel, nick, reason) {
    const key = normalizeChannel(channel);
    if (!this.isOp(client, key)) return fail(`You're not a channel operator on ${key}. Try /op after an oper grants it.`);
    const target = this.findNick(nick);
    if (!target || !target.channels.has(key)) return fail(`They're not on ${key}.`);
    if (target.isBot) return fail("You can't kick a service bot. Use /bs unassign.");
    if (target.oper && !client.oper) return fail("You can't kick a network oper.");
    const why = sanitize(reason, 80) || client.nick;
    this._announce(key, 'kick', client.nick, `${target.nick} was kicked from ${key} by ${client.nick} (${why})`, {
      fingerprint: client.fingerprint
    });
    this.opsLog(`${client.nick} kicked ${target.nick} from ${key} (${why})`);
    target.channels.delete(key);
    this.rememberChannel(target, key, false);
    state.onChange();
    return ok({ status: `Kicked ${target.nick} from ${key}` });
  }

  setStatus(client, channel, nick, letter, give, { silent } = {}) {
    const key = normalizeChannel(channel);
    const need = letter === 'v' ? 30 : 30;
    if (letter === 'o' || letter === 'h' || letter === 'a') {
      if (!this.isOp(client, key)) {
        return fail(`You're not a channel operator on ${key}. A current op must /op you first.`);
      }
    } else if (!this.isOp(client, key) && !this.isHalfop(client, key)) {
      return fail(`You're not a channel operator on ${key}.`);
    }
    void need;
    const target = this.findNick(nick);
    const name = target ? target.nick : nick;
    if (!isValidNick(name)) return fail('Invalid nick.');
    if (give && target && !target.channels.has(key)) return fail(`${name} is not on ${key}.`);
    const ch = state.ensureChannel(key);
    const ln = lower(name);
    if (target?.isBot && !give) {
      return fail("You can't strip status from a service bot. Use /bs unassign.");
    }
    if (letter === 'o' && !give && ln === ch.founder && !client.oper && lower(client.nick) !== ln) {
      return fail("You can't deop the channel founder (network oper can).");
    }
    this.setLive(ch, ln, letter, give);
    if (ch.registered && this.accessRank(client, key) >= 40) {
      const flag = { o: 'O', v: 'V', h: 'H', a: 'A' }[letter];
      if (flag) this.mutateFlags(ch, ln, (give ? '+' : '-') + flag);
    }
    if (!silent) {
      this.announceMode(key, client.nick, `${give ? '+' : '-'}${letter} ${name}`, client.fingerprint);
      this.opsLog(`${client.nick} sets ${give ? '+' : '-'}${letter} ${name} on ${key}`);
      state.onChange();
    }
    const word = { o: 'op', v: 'voice', h: 'halfop', a: 'admin' }[letter] || letter;
    return ok({
      status: give ? `${name} is now ${word} on ${key}` : `${name} is no longer ${word} on ${key}`
    });
  }

  setOp(client, channel, nick, give, opts) {
    return this.setStatus(client, channel, nick, 'o', give, opts);
  }

  setVoice(client, channel, nick, give, opts) {
    return this.setStatus(client, channel, nick, 'v', give, opts);
  }

  setHop(client, channel, nick, give, opts) {
    return this.setStatus(client, channel, nick, 'h', give, opts);
  }

  ban(client, channel, mask, reason, add = true) {
    const key = normalizeChannel(channel);
    if (!this.isOp(client, key)) return fail(`You're not a channel operator on ${key}.`);
    const ch = state.ensureChannel(key);
    const target = this.findNick(mask);
    const resolved = target ? `*!${target.ident}@${target.ip}` : mask;
    if (add) {
      if (ch.bans.some((b) => lower(b.mask) === lower(resolved))) return ok({ status: `Ban already exists on ${key}` });
      ch.bans.push({ mask: resolved, setBy: client.nick, setAt: Date.now(), reason: sanitize(reason, 80) });
      this.announceMode(key, client.nick, `+b ${resolved}`, client.fingerprint);
      if (target && target.channels.has(key) && !target.oper && !target.isBot) {
        this._announce(key, 'kick', client.nick, `${target.nick} was kicked from ${key} by ${client.nick} (banned)`, { fingerprint: client.fingerprint });
        target.channels.delete(key);
      }
      state.onChange();
      return ok({ status: `Banned ${resolved} from ${key}` });
    }
    const before = ch.bans.length;
    ch.bans = ch.bans.filter((b) => lower(b.mask) !== lower(resolved) && lower(b.mask) !== lower(mask));
    if (ch.bans.length === before) return fail(`No matching ban on ${key}. Try /mode ${key} +b`);
    this.announceMode(key, client.nick, `-b ${resolved}`, client.fingerprint);
    state.onChange();
    return ok({ status: `Unbanned ${resolved} from ${key}` });
  }

  invite(client, nick, channel) {
    const key = normalizeChannel(channel);
    if (!client.channels.has(key)) return fail(`You're not on ${key}.`);
    const ch = state.channels[key];
    if (ch?.modes.i && !this.isOp(client, key)) return fail(`You're not a channel operator on ${key}.`);
    const target = this.findNick(nick);
    if (!target) return fail(`No such nick: ${nick}`);
    if (!this.invites.has(key)) this.invites.set(key, new Set());
    this.invites.get(key).add(lower(target.nick));
    return ok({
      status: `Invited ${target.nick} to ${key}`,
      lines: []
    });
  }

  mode(client, channel, spec, args = []) {
    const key = normalizeChannel(channel);
    const ch = state.channels[key];
    if (!ch) return fail('No such channel.');
    if (!spec) {
      const flags = Object.entries(ch.modes)
        .filter(([k, v]) => v && k.length === 1 && k !== 'k' && k !== 'l')
        .map(([k]) => k)
        .join('');
      const extra = [];
      if (ch.modes.k) extra.push('+k');
      if (ch.modes.l) extra.push('+l ' + ch.modes.l);
      return ok({ status: `Mode ${key} +${flags}${ch.modes.k ? 'k' : ''}${ch.modes.l ? 'l' : ''}${extra.length ? ' ' + extra.join(' ') : ''}` });
    }
    if (!this.isOp(client, key)) return fail(`You're not a channel operator on ${key}.`);
    let adding = true;
    let argi = 0;
    const applied = [];
    for (const c of spec) {
      if (c === '+') { adding = true; continue; }
      if (c === '-') { adding = false; continue; }
      if ('ntmis'.includes(c)) {
        ch.modes[c] = adding;
        applied.push((adding ? '+' : '-') + c);
      } else if (c === 'k') {
        if (adding) {
          const k = args[argi++] || '';
          ch.modes.k = k;
          applied.push('+k ' + k);
        } else {
          ch.modes.k = '';
          applied.push('-k');
        }
      } else if (c === 'l') {
        if (adding) {
          ch.modes.l = parseInt(args[argi++] || '0', 10) || 0;
          applied.push('+l ' + ch.modes.l);
        } else {
          ch.modes.l = 0;
          applied.push('-l');
        }
      } else if (c === 'o') {
        const n = args[argi++];
        if (n) this.setOp(client, key, n, adding, { silent: true });
        applied.push((adding ? '+o ' : '-o ') + (n || ''));
      } else if (c === 'v') {
        const n = args[argi++];
        if (n) this.setVoice(client, key, n, adding, { silent: true });
        applied.push((adding ? '+v ' : '-v ') + (n || ''));
      } else if (c === 'h') {
        const n = args[argi++];
        if (n) this.setHop(client, key, n, adding, { silent: true });
        applied.push((adding ? '+h ' : '-h ') + (n || ''));
      } else if (c === 'b') {
        const m = args[argi++];
        if (adding && !m) {
          const lines = (ch.bans || []).map((b) => `${key} +b ${b.mask}  set by ${b.setBy}`);
          return infoLines(lines.length ? lines : [`${key} has no bans.`]);
        }
        if (m) this.ban(client, key, m, '', adding);
        applied.push((adding ? '+b ' : '-b ') + (m || ''));
      }
    }
    if (applied.length) {
      this.announceMode(key, client.nick, applied.join(' '), client.fingerprint);
      state.onChange();
    }
    return ok({ status: applied.length ? `Mode ${key} ${applied.join(' ')}` : `Mode ${key}` });
  }

  kill(client, nick, reason) {
    if (!client.oper) return fail('Permission denied. You must be a network oper.');
    const target = this.findNick(nick);
    if (!target) return fail(`No such nick: ${nick}`);
    if (target.isBot) return fail('That is a BotServ bot. Use /bs BOT DEL or /bs UNASSIGN.');
    const why = sanitize(reason, 80) || 'Killed by oper';
    for (const ch of target.channels) {
      this._announce(ch, 'quit', target.nick, `${target.nick} has quit (Killed: ${why})`, { fingerprint: target.fingerprint });
    }
    target.onKill(`You were killed by ${client.nick}: ${why}`);
    this.disconnect(target.id, 'Killed: ' + why);
    this.opsLog(`${client.nick} killed ${nick} (${why})`);
    return ok({ status: `Killed ${nick}` });
  }

  kline(client, target, reason) {
    if (!client.oper) return fail('Permission denied. You must be a network oper.');
    const who = String(target || '');
    let type = 'nick';
    let value = who;
    const online = this.findNick(who);
    const looksFp = /^(web:|ed25519:|sha256:|SHA256:)/.test(who);
    const looksIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(who) || who.includes('::') || (who.match(/:/g) || []).length > 2;
    if (looksFp) {
      type = 'fingerprint';
    } else if (looksIp) {
      type = 'ip';
    } else if (online) {
      if (String(online.fingerprint).startsWith('web:')) {
        type = 'ip';
        value = online.ip;
      } else {
        type = 'fingerprint';
        value = online.fingerprint;
      }
    }
    const ban = state.addServerBan({ type, value, reason: sanitize(reason, 80), setBy: client.nick });
    const victims = [...this.clients.values()].filter((c) => this.checkBan(c));
    for (const v of victims) {
      v.onKill(`You are banned from shrc (${ban.reason})`);
      this.disconnect(v.id, 'Banned: ' + ban.reason);
    }
    this.opsLog(`${client.nick} k-line ${type}=${ban.value} (${ban.reason})`);
    return ok({ status: `K-line added: ${type}=${ban.value} (${ban.reason})` });
  }

  unkline(client, value) {
    if (!client.oper) return fail('Permission denied.');
    const v = String(value || '').toLowerCase();
    let removed = false;
    for (const type of ['fingerprint', 'ip', 'nick']) {
      if (state.removeServerBan(type, v)) removed = true;
    }
    const online = this.findNick(value);
    if (online && state.removeServerBan('fingerprint', online.fingerprint)) removed = true;
    return removed ? ok({ status: `Removed k-line for ${value}` }) : fail('No matching k-line.');
  }

  nickServCmd(client, currentBuffer, text) {
    const raw = String(text || '').trim();
    if (!raw) {
      return infoLines([
        'NickServ: IDENTIFY <password>',
        'NickServ: REGISTER <password> [email]',
        'NickServ: GHOST <nick> <password>',
        'NickServ: DROP <password>'
      ]);
    }
    const sp = raw.indexOf(' ');
    const cmd = (sp === -1 ? raw : raw.slice(0, sp)).toLowerCase();
    const rest = (sp === -1 ? '' : raw.slice(sp + 1)).trim();
    switch (cmd) {
      case 'identify':
      case 'id':
        return this.exec(client, currentBuffer, '/identify ' + rest);
      case 'register':
        return this.exec(client, currentBuffer, '/register ' + rest);
      case 'ghost':
        return this.exec(client, currentBuffer, '/ghost ' + rest);
      case 'drop':
        return this.exec(client, currentBuffer, '/drop ' + rest);
      case 'help':
        return infoLines([
          'NickServ: IDENTIFY <password>',
          'NickServ: REGISTER <password> [email]',
          'NickServ: GHOST <nick> <password>',
          'NickServ: DROP <password>'
        ]);
      default:
        return fail('NickServ: unknown command. IDENTIFY, REGISTER, GHOST, DROP, HELP');
    }
  }

  exec(client, currentBuffer, raw) {
    const line = String(raw || '').replace(/^\s+/, '');
    if (!line.startsWith('/')) {
      if (!currentBuffer || currentBuffer === '*server*') {
        return fail('Join a channel first: /join #lounge');
      }
      return this.privmsg(client, currentBuffer, line);
    }

    const trimmed = line.slice(1);
    const sp = trimmed.indexOf(' ');
    const cmd = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
    const rest = (sp === -1 ? '' : trimmed.slice(sp + 1)).trim();
    const args = rest.length ? rest.split(/\s+/) : [];
    const channelOf = (maybe) => {
      if (maybe && (maybe.startsWith('#') || maybe.startsWith('query:'))) return maybe;
      if (currentBuffer && currentBuffer.startsWith('#')) return currentBuffer;
      return '#lounge';
    };

    switch (cmd) {
      case 'help':
      case 'commands':
        return infoLines([
          '--- client ---',
          '/nick <name>          change nick (guests start as Guest######)',
          '/join <#chan> [key]   join or create a channel',
          '/part [#chan] [msg]   leave a channel',
          '/quit [msg]           disconnect',
          '/msg <nick> <text>    private message',
          '/query <nick>         open a query window',
          '/notice <tgt> <text>  send a notice',
          '/me <action>          emote in the current channel',
          'Ctrl+K color  Ctrl+B bold  Ctrl+U underline  Ctrl+O reset',
          '/topic [#chan] [text] view or set topic',
          '/names [#chan]        list nicks',
          '/who [#chan]          who is here',
          '/whois <nick>         lookup a nick (opers see real IP)',
          '/list                 list channels',
          '/away [msg]           set or clear away',
          '/invite <nick> [#ch]  invite someone',
          '/ignore <nick>        ignore a nick (saved if identified)',
          '/unignore <nick>      /ignore with no args lists',
          '/watch +nick|-nick    notify when they sign on/off',
          '/set clock 12|24      /set beep on|off',
          '/motd  /ping  /clear  /cycle',
          '--- services (Anope-style) ---',
          '/ns /nickserv         REGISTER IDENTIFY GHOST INFO AJOIN SET',
          '/cs /chanserv         REGISTER FLAGS SOP AOP HOP VOP AKICK SET',
          '/ms /memoserv         SEND LIST READ DEL',
          '/os /operserv         KILL AKILL GLOBAL MODE OPER (opers)',
          '/bs /botserv          ASSIGN UNASSIGN SAY ACT SET FANTASY',
          '                      in-channel: .op .kick .access add nick 5',
          '/hs /hostserv         REQUEST ON OFF SET (vhosts)',
          '/msg NickServ IDENTIFY <pass>',
          'SSH key auto-identifies a nick registered with that key.',
          '--- channel ops ---',
          '/op <nick>            grant channel operator',
          '/deop <nick>          take channel operator away',
          '/voice <nick>   /devoice <nick>',
          '/kick <nick> [reason]',
          '/ban <nick|mask> [reason]',
          '/unban <nick|mask>',
          '/mode [#chan] [+ntmiblk ov]',
          '--- network opers ---',
          '/oper <password>      identify as network oper',
          '/kill <nick> [reason] disconnect someone',
          '/akill <nick|ip|fp> [reason]  network ban + kill (alias /kline)',
          '/kline <nick|ip|fp> [reason]  server ban',
          '/unkline <target>     lift a server ban',
          '/klines               list server bans',
          '/opergrant <nick>     make a registered nick an oper',
          '/deoper <nick>',
          '/wallops <text>'
        ]);

      case 'nick':
        if (!args[0]) return fail('Usage: /nick <new_name>');
        return this.changeNick(client, args[0]);

      case 'join':
      case 'j':
      case 'channel': {
        if (!args[0]) return fail('Usage: /join <#channel> [key]');
        const names = args[0].split(',');
        let last = fail('Usage: /join <#channel>');
        for (const n of names) last = this.join(client, n, args[1]);
        return last;
      }

      case 'part':
      case 'leave':
        return this.part(client, args[0] && args[0].startsWith('#') ? args[0] : currentBuffer, args[0] && args[0].startsWith('#') ? args.slice(1).join(' ') : rest);

      case 'quit':
      case 'exit':
      case 'disconnect':
        return { ok: true, error: null, status: '', lines: [], switchBuffer: null, quit: true, reason: rest || 'Quit', openQuery: null };

      case 'msg':
      case 'privmsg': {
        if (args.length < 2) return fail('Usage: /msg <nick|#channel> <text>');
        const tgt = args[0];
        const text = rest.slice(args[0].length).trim();
        const svc = { nickserv: 'NickServ', ns: 'NickServ', chanserv: 'ChanServ', cs: 'ChanServ', memoserv: 'MemoServ', ms: 'MemoServ', operserv: 'OperServ', os: 'OperServ', botserv: 'BotServ', bs: 'BotServ', hostserv: 'HostServ', hs: 'HostServ' }[lower(tgt)];
        if (svc) return handleService(this, client, currentBuffer, svc, text);
        return this.privmsg(client, tgt, text);
      }

      case 'ns':
      case 'nickserv':
        return handleService(this, client, currentBuffer, 'NickServ', rest || 'help');

      case 'cs':
      case 'chanserv':
        return handleService(this, client, currentBuffer, 'ChanServ', rest || 'help');

      case 'ms':
      case 'memoserv':
        return handleService(this, client, currentBuffer, 'MemoServ', rest || 'help');

      case 'os':
      case 'operserv':
        return handleService(this, client, currentBuffer, 'OperServ', rest || 'help');

      case 'bs':
      case 'botserv':
        return handleService(this, client, currentBuffer, 'BotServ', rest || 'help');

      case 'hs':
      case 'hostserv':
        return handleService(this, client, currentBuffer, 'HostServ', rest || 'help');

      case 'query':
      case 'q': {
        if (!args[0]) return fail('Usage: /query <nick>');
        const dest = this.findNick(args[0]);
        const other = dest ? dest.nick : args[0];
        const room = pmRoom(client.nick, other);
        client.queries.add(other);
        if (dest) dest.queries.add(client.nick);
        if (!dest) {
          const registered = state.isNickProtected(other);
          return ok({
            switchBuffer: room,
            openQuery: other,
            status: registered
              ? `${other} is offline. /msg ${other} text sends a memo.`
              : `${other} is not online.`
          });
        }
        return ok({ switchBuffer: room, openQuery: dest.nick, status: `Query with ${dest.nick}` });
      }

      case 'notice': {
        if (args.length < 2) return fail('Usage: /notice <nick|#channel> <text>');
        const tgt = args[0];
        const text = rest.slice(args[0].length).trim();
        return this.privmsg(client, tgt, text, 'notice');
      }

      case 'me':
      case 'action':
        if (!rest) return fail('Usage: /me <action>');
        if (!currentBuffer || currentBuffer === '*server*') return fail('Join a channel first.');
        return this.privmsg(client, currentBuffer, rest, 'action');

      case 'topic': {
        const chan = args[0] && args[0].startsWith('#') ? args[0] : currentBuffer;
        const text = args[0] && args[0].startsWith('#') ? args.slice(1).join(' ') : rest;
        return this.topic(client, chan, text === '' ? null : text);
      }

      case 'names': {
        const chan = channelOf(args[0]);
        const names = this.nicklist(chan).map((n) => n.prefix + n.nick).join('  ');
        return infoLines([`${chan}: ${names || '(empty)'}`]);
      }

      case 'who': {
        const chan = channelOf(args[0]);
        const lines = this.nicklist(chan).map((n) => {
          const c = this.findNick(n.nick);
          return `${n.prefix}${n.nick}  ${c ? hostmask(c, client) : ''}  ${n.away ? '[away]' : ''}${n.identified ? ' [id]' : ''}${n.oper ? ' [*]' : ''}`;
        });
        return infoLines(lines.length ? [`WHO ${chan}`, ...lines] : [`${chan}: nobody here`]);
      }

      case 'whois': {
        const nick = args[0] || client.nick;
        const t = this.findNick(nick);
        if (!t) return fail(`No such nick: ${nick}`);
        const chans = [...t.channels].map((ch) => this.prefix(t, ch) + ch).join(' ');
        const idle = Math.floor((Date.now() - t.lastActive) / 1000);
        const lines = [
          `${t.nick} (${hostmask(t)})`,
          `channels: ${chans || '(none)'}`,
          t.identified ? `identified as ${t.account}` : 'not identified',
          t.oper ? 'is a network operator' : 'is a regular user',
          t.away ? `away: ${t.away}` : 'not away',
          `idle ${idle}s, signed on ${Math.floor((Date.now() - t.connectedAt) / 1000)}s ago`
        ];
        if (client.oper) {
          lines.push(`ip ${t.ip || 'unknown'}  cloak ${cloakHost(t)}`);
          lines.push(`fp ${t.fingerprint}`);
        }
        return infoLines(lines);
      }

      case 'list': {
        const lines = Object.values(state.channels)
          .filter((ch) => !ch.modes.s || client.channels.has(ch.name) || client.oper)
          .map((ch) => {
            const n = this.members(ch.name).length;
            return `${ch.name}  ${n}  ${ch.topic || ''}`;
          });
        return infoLines(lines.length ? ['channel  users  topic', ...lines] : ['no channels']);
      }

      case 'away':
        client.away = rest || null;
        return ok({ status: client.away ? `You are now away: ${client.away}` : 'You are no longer marked as being away.' });

      case 'motd':
        return infoLines(['- shrc message of the day -', ...MOTD, '- end of MOTD -']);

      case 'ping':
        return ok({ status: 'PONG from shrc' });

      case 'invite': {
        if (!args[0]) return fail('Usage: /invite <nick> [#channel]');
        const chan = args[1] ? args[1] : currentBuffer;
        const res = this.invite(client, args[0], chan);
        const dest = this.findNick(args[0]);
        if (res.ok && dest) {
          // dest sees a local-style notice next render via a system line in *server* — also drop into their current via announce isn't global.
        }
        return res;
      }

      case 'ignore':
        if (!args[0]) {
          const list = [...(client.ignores || [])];
          return list.length ? infoLines(list.map((n) => `ignore ${n}`)) : ok({ status: 'Ignore list empty.' });
        }
        client.ignores.add(lower(args[0]));
        this.persistPrefs(client);
        return ok({ status: `Ignoring ${args[0]}` });

      case 'unignore':
        if (!args[0]) return fail('Usage: /unignore <nick>');
        client.ignores.delete(lower(args[0]));
        this.persistPrefs(client);
        return ok({ status: `No longer ignoring ${args[0]}` });

      case 'watch':
      case 'notify': {
        if (!client.watch) client.watch = new Set();
        if (!args[0]) {
          const list = [...client.watch];
          return list.length ? infoLines(list.map((n) => `watch ${n}`)) : ok({ status: 'Watch list empty. /watch +nick' });
        }
        let name = args[0];
        let add = true;
        if (name.startsWith('+')) { add = true; name = name.slice(1); }
        else if (name.startsWith('-')) { add = false; name = name.slice(1); }
        if (!name) return fail('Usage: /watch +nick  or  /watch -nick');
        if (add) client.watch.add(lower(name));
        else client.watch.delete(lower(name));
        this.persistPrefs(client);
        return ok({ status: add ? `Watching ${name}` : `No longer watching ${name}` });
      }

      case 'set': {
        const what = lower(args[0]);
        const val = lower(args[1] || '');
        if (what === 'clock') {
          client.hour12 = val === '12';
          return ok({ status: `Clock set to ${client.hour12 ? '12-hour' : '24-hour'}.` });
        }
        if (what === 'beep') {
          client.beep = !/^(off|0|false|no)$/i.test(val || 'on');
          return ok({ status: `Mention beep ${client.beep ? 'on' : 'off'}.` });
        }
        if (what === 'mouse') {
          return ok({ status: 'Mouse tracking is on for SSH (shift-drag to copy). Web tty uses drag-select.' });
        }
        return fail('Usage: /set clock 12|24   /set beep on|off');
      }

      case 'clear':
        return { ...ok({ status: 'Buffer cleared locally.' }), clear: true };

      case 'cycle': {
        const chan = currentBuffer;
        if (!chan || !chan.startsWith('#')) return fail('You are not on a channel.');
        this.part(client, chan, 'cycling');
        return this.join(client, chan);
      }

      case 'register': {
        if (!args[0]) return fail('Usage: /register <password> [email]');
        const res = state.registerNick(client.nick, args[0], args[1] || '', client.fingerprint);
        if (res.success) {
          client.identified = true;
          client.account = client.nick;
          const acc = state.getAccount(client.nick);
          client.oper = !!(acc && acc.isOper);
          this.clearEnforce(client);
          if (acc && isStickyFingerprint(client.fingerprint)) acc.fingerprint = client.fingerprint;
        }
        return res.success ? ok({ status: res.message }) : fail(res.message);
      }

      case 'identify':
      case 'id': {
        if (!args[0]) return fail('Usage: /identify <password>');
        const res = state.identifyNick(client.nick, args[0]);
        if (res.success) {
          client.identified = true;
          client.account = client.nick;
          client.oper = !!(res.account && res.account.isOper);
          this.clearEnforce(client);
          const extra = [];
          if (isStickyFingerprint(client.fingerprint)) {
            res.account.fingerprint = client.fingerprint;
            extra.push('This identity is now bound to your nick. Reconnect will auto-identify.');
          }
          this.loadAccountPrefs(client);
          for (const ch of [...client.channels]) {
            this.applyAccess(client, ch);
            this.rememberChannel(client, ch, true);
          }
          const ajoin = res.account.ajoin || [];
          for (const ch of ajoin) {
            if (!client.channels.has(normalizeChannel(ch))) {
              const jr = this.join(client, ch);
              if (jr.ok) extra.push(`Autojoined ${ch}`);
            }
          }
          const memos = state.getMemos(client.account).filter((m) => m.unread);
          if (memos.length) extra.push(`You have ${memos.length} new memo(s). /ms read`);
          state.onChange();
          const status = res.message + (client.oper ? ' (network oper)' : '');
          return ok({
            status,
            lines: extra.map((text) => ({ type: 'notice', author: 'NickServ', text, timestamp: Date.now() }))
          });
        }
        return fail(res.message);
      }

      case 'ghost': {
        if (args.length < 2) return fail('Usage: /ghost <nick> <password>');
        const res = state.identifyNick(args[0], args[1]);
        if (!res.success) return fail(res.message);
        const stale = this.findNick(args[0]);
        if (stale && stale !== client) {
          stale.onKill(`Ghosted by ${client.nick}`);
          this.disconnect(stale.id, 'Ghosted');
        }
        client.identified = true;
        client.account = args[0];
        client.oper = !!(res.account && res.account.isOper);
        this.clearEnforce(client);
        if (res.account && isStickyFingerprint(client.fingerprint)) res.account.fingerprint = client.fingerprint;
        return this.changeNick(client, args[0]);
      }

      case 'drop': {
        if (!args[0]) return fail('Usage: /drop <password>');
        const res = state.dropNick(client.nick, args[0]);
        if (res.success) {
          client.identified = false;
          client.account = null;
          client.oper = false;
        }
        return res.success ? ok({ status: res.message }) : fail(res.message);
      }

      case 'op': {
        if (!args[0]) return fail('Usage: /op <nick>  (in the channel you want to grant op on)');
        const nick = args[0].startsWith('#') ? args[1] : args[0];
        const chan = args[0].startsWith('#') ? args[0] : currentBuffer;
        if (!nick) return fail('Usage: /op <nick>');
        if (!chan || !chan.startsWith('#')) return fail('Join a channel, then /op <nick>.');
        return this.setOp(client, chan, nick, true);
      }

      case 'deop': {
        if (!args[0]) return fail('Usage: /deop <nick>');
        const nick = args[0].startsWith('#') ? args[1] : args[0];
        const chan = args[0].startsWith('#') ? args[0] : currentBuffer;
        if (!nick) return fail('Usage: /deop <nick>');
        if (!chan || !chan.startsWith('#')) return fail('Join a channel, then /deop <nick>.');
        return this.setOp(client, chan, nick, false);
      }

      case 'voice': {
        if (!args[0]) return fail('Usage: /voice <nick>');
        return this.setVoice(client, currentBuffer, args[0], true);
      }

      case 'devoice': {
        if (!args[0]) return fail('Usage: /devoice <nick>');
        return this.setVoice(client, currentBuffer, args[0], false);
      }

      case 'hop':
      case 'halfop': {
        if (!args[0]) return fail('Usage: /hop <nick>');
        return this.setHop(client, currentBuffer, args[0], true);
      }

      case 'dehop':
      case 'dehalfop': {
        if (!args[0]) return fail('Usage: /dehop <nick>');
        return this.setHop(client, currentBuffer, args[0], false);
      }

      case 'kick': {
        if (!args[0]) return fail('Usage: /kick <nick> [reason]');
        const nick = args[0].startsWith('#') ? args[1] : args[0];
        const chan = args[0].startsWith('#') ? args[0] : currentBuffer;
        const reason = args[0].startsWith('#') ? args.slice(2).join(' ') : args.slice(1).join(' ');
        return this.kick(client, chan, nick, reason);
      }

      case 'ban': {
        if (!args[0]) return fail('Usage: /ban <nick|mask> [reason]');
        return this.ban(client, currentBuffer, args[0], args.slice(1).join(' '), true);
      }

      case 'unban': {
        if (!args[0]) return fail('Usage: /unban <nick|mask>');
        return this.ban(client, currentBuffer, args[0], '', false);
      }

      case 'mode': {
        const chan = args[0] && args[0].startsWith('#') ? args[0] : currentBuffer;
        const spec = args[0] && args[0].startsWith('#') ? args[1] : args[0];
        const modeArgs = args[0] && args[0].startsWith('#') ? args.slice(2) : args.slice(1);
        return this.mode(client, chan, spec, modeArgs);
      }

      case 'oper': {
        const pass = args[0] || '';
        const envPass = process.env.SHRC_OPER_PASSWORD || '';
        if (envPass && pass === envPass) {
          client.oper = true;
          return ok({ status: 'You are now a network operator. (SHRC_OPER_PASSWORD)' });
        }
        const acc = state.getAccount(client.nick);
        if (!acc) return fail('Register this nick first, then /identify, then /oper <password>.');
        if (!verifyPassword(pass, acc.passwordHash)) return fail('Invalid oper password (use your NickServ password).');
        if (!acc.isOper) return fail('Your account is not an oper. An existing oper must /opergrant you.');
        client.identified = true;
        client.account = client.nick;
        client.oper = true;
        return ok({ status: 'You are now a network operator.' });
      }

      case 'kill': {
        if (!args[0]) return fail('Usage: /kill <nick> [reason]');
        return this.kill(client, args[0], args.slice(1).join(' '));
      }

      case 'akill': {
        if (!args[0]) return fail('Usage: /akill <nick|ip|fingerprint> [reason]');
        const reason = args.slice(1).join(' ') || 'akill';
        const kl = this.kline(client, args[0], reason);
        if (!kl.ok) return kl;
        const online = this.findNick(args[0]);
        if (online && online !== client) this.kill(client, args[0], reason);
        return ok({ status: kl.status });
      }

      case 'kline':
      case 'gline':
      case 'banfp': {
        if (!args[0]) return fail('Usage: /kline <nick|ip|fingerprint> [reason]');
        return this.kline(client, args[0], args.slice(1).join(' '));
      }

      case 'unkline':
      case 'ungline': {
        if (!args[0]) return fail('Usage: /unkline <target>');
        return this.unkline(client, args[0]);
      }

      case 'klines':
      case 'bans': {
        if (!client.oper) return fail('Permission denied.');
        const lines = state.serverBans.map((b) => `${b.type}=${b.value}  by ${b.setBy}  (${b.reason})`);
        return infoLines(lines.length ? lines : ['no k-lines']);
      }

      case 'opergrant': {
        if (!client.oper) return fail('Permission denied.');
        if (!args[0]) return fail('Usage: /opergrant <nick>');
        if (!state.setOper(args[0], true)) return fail('That nick is not registered.');
        const t = this.findNick(args[0]);
        if (t && t.identified && lower(t.nick) === lower(args[0])) t.oper = true;
        this.opsLog(`${client.nick} opergrant ${args[0]}`);
        return ok({ status: `${args[0]} is now a network oper (they must /identify).` });
      }

      case 'deoper': {
        if (!client.oper) return fail('Permission denied.');
        if (!args[0]) return fail('Usage: /deoper <nick>');
        state.setOper(args[0], false);
        const t = this.findNick(args[0]);
        if (t) t.oper = false;
        return ok({ status: `${args[0]} is no longer a network oper.` });
      }

      case 'wallops': {
        if (!client.oper) return fail('Permission denied.');
        if (!rest) return fail('Usage: /wallops <text>');
        for (const c of this.clients.values()) {
          if (!c.oper && !c.channels.size) continue;
          // dump into lounge as a wallops-style notice for everyone
        }
        this._announce('#lounge', 'notice', client.nick, `[WALLOPS] ${sanitize(rest, 200)}`, { fingerprint: client.fingerprint });
        return ok({ status: 'Wallops sent.' });
      }

      default:
        return fail(`Unknown command /${cmd}. Type /help`);
    }
  }
}

export const irc = new IrcNetwork();
