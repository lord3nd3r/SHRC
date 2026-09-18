import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SQLITE_FILE = path.join(DATA_DIR, 'shrc.sqlite');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  try {
    if (stored.startsWith('scrypt$')) {
      const parts = stored.split('$');
      if (parts.length !== 3) return false;
      const [, salt, hash] = parts;
      const check = crypto.scryptSync(String(password), salt, 32).toString('hex');
      const a = Buffer.from(hash, 'hex');
      const b = Buffer.from(check, 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    }
    const legacy = crypto.createHash('sha256').update(String(password)).digest('hex');
    return stored === legacy;
  } catch {
    return false;
  }
}

export function emptyFlags() {
  return {};
}

export function normalizeChanRecord(ch) {
  if (!ch) return ch;
  if (!ch.modes) ch.modes = { n: true, t: true, m: false, i: false, s: false, k: '', l: 0 };
  if (!ch.bans) ch.bans = [];
  if (!ch.ops) ch.ops = [];
  if (!ch.voices) ch.voices = [];
  if (!ch.halfops) ch.halfops = [];
  if (!ch.admins) ch.admins = [];
  if (!ch.flags) ch.flags = {};
  if (!ch.akick) ch.akick = [];
  if (!ch.botserv) ch.botserv = { bot: '', fantasy: true, greet: '', dontkickops: true, dontkickvoices: false };
  if (ch.registered == null) ch.registered = false;
  if (!ch.settings) {
    ch.settings = {
      keeptopic: true,
      secure: true,
      restricted: false,
      mlock: '+nt',
      entrymsg: '',
      desc: '',
      url: '',
      email: '',
      successor: ''
    };
  }
  return ch;
}

function defaultChannel(name, topic, extra = {}) {
  return normalizeChanRecord({
    name,
    topic,
    topicBy: extra.topicBy || 'shrc',
    topicAt: extra.topicAt || Date.now(),
    modes: { n: true, t: true, m: false, i: false, s: false, k: '', l: 0, ...(extra.modes || {}) },
    bans: extra.bans || [],
    ops: extra.ops || [],
    voices: extra.voices || [],
    halfops: extra.halfops || [],
    admins: extra.admins || [],
    founder: extra.founder || '',
    registered: extra.registered || false,
    flags: extra.flags || {},
    akick: extra.akick || [],
    createdAt: extra.createdAt || Date.now()
  });
}

function defaultChannels() {
  return {
    '#lounge': defaultChannel('#lounge', 'cozy lounge — idle, coffee, hellos'),
    '#linux': defaultChannel('#linux', 'kernel, distros, shells, rice'),
    '#dev': defaultChannel('#dev', 'building things. paste bins welcome'),
    '#general': defaultChannel('#general', 'catch-all'),
    '#random': defaultChannel('#random', 'off-topic and shitposts')
  };
}

const defaultAccounts = {
  late_architect: {
    nickname: 'late_architect',
    passwordHash: hashPassword('admin123'),
    fingerprint: 'ed25519:shrc_init',
    email: 'admin@shrc.live',
    registeredAt: Date.now() - 864000000,
    isOper: true
  }
};

class StateStore {
  constructor() {
    this.chat = {
      '#lounge': [],
      '#linux': [
        { id: 'm1', type: 'privmsg', room: '#linux', author: 'PenciledAnvil', fingerprint: 'ed25519:init1', text: '(  )\n(  (\nc[_]', timestamp: Date.now() - 36000000, tags: { time: new Date().toISOString(), account: '*' } },
        { id: 'm2', type: 'privmsg', room: '#linux', author: 'readfox', fingerprint: 'ed25519:init2', text: 'oh yeah did you guys see the new KDE announcement?', timestamp: Date.now() - 36000000, tags: { time: new Date().toISOString(), account: '*' } }
      ],
      '#dev': [],
      '#general': [],
      '#random': []
    };

    this.channels = defaultChannels();
    this.accounts = { ...defaultAccounts };
    this.serverBans = [];
    this.memos = {};
    this.bots = {
      HelpBot: {
        nick: 'HelpBot',
        ident: 'bot',
        host: 'services.shrc',
        realname: 'a helpful robot',
        createdBy: 'shrc'
      }
    };
    this.stats = {
      totalConnections: 0,
      activeUsers: 0
    };
    this.settings = this.settings || {
      ircEnabled: true,
      motd: [],
      hour12: false
    };
    this.webNicks = {};

    this.listeners = new Set();
    this._saveTimer = null;
    this._sqlDb = null;
    this._sqlFlush = null;
    this.load();
  }

  attachSql(db, flush) {
    this._sqlDb = db;
    this._sqlFlush = flush;
    db.run('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const row = db.exec('SELECT v FROM kv WHERE k = \'snapshot\'');
    if (row.length && row[0].values.length) {
      try {
        const data = JSON.parse(row[0].values[0][0]);
        this.applySnapshot(data);
        console.log('[StateStore] Loaded persistent state from shrc.sqlite');
        return;
      } catch (err) {
        console.error('[StateStore] sqlite snapshot corrupt:', err.message);
      }
    }
  }

  applySnapshot(data) {
    if (!data || typeof data !== 'object') return;
    try {
      if (data.chat) this.chat = data.chat;
      if (data.accounts) this.accounts = data.accounts;
      if (data.serverBans) this.serverBans = data.serverBans;
      if (data.memos) this.memos = data.memos;
      if (data.bots) this.bots = { ...this.bots, ...data.bots };
      if (data.stats) {
        this.stats = { ...this.stats, ...data.stats, activeUsers: 0 };
        delete this.stats.pixelsPainted;
      }

      if (data.channels) {
        this.channels = data.channels;
      } else if (data.topics) {
        this.channels = defaultChannels();
        for (const [name, topic] of Object.entries(data.topics)) {
          if (!this.channels[name]) this.channels[name] = defaultChannel(name, topic, { ops: [] });
          else this.channels[name].topic = topic;
        }
      }

      if (data.settings) this.settings = { motd: [], hour12: false, ...this.settings, ...data.settings };
      if (data.webNicks) this.webNicks = data.webNicks;

      for (const acc of Object.values(this.accounts)) {
        const n = String(acc.nickname || '').toLowerCase();
        if (n === 'late_architect' || n === 'end3r') acc.isOper = true;
        if (!acc.ajoin) acc.ajoin = [];
        if (!acc.ignores) acc.ignores = [];
        if (!acc.watch) acc.watch = [];
      }
      for (const ch of Object.values(this.channels)) normalizeChanRecord(ch);
      const lounge = this.channels['#lounge'];
      if (lounge) {
        lounge.registered = true;
        lounge.founder = 'end3r';
        lounge.flags = lounge.flags || {};
        lounge.flags.end3r = 'F';
        if (!lounge.flags.late_architect) lounge.flags.late_architect = 'O';
        lounge.settings.desc = lounge.settings.desc || 'the first channel';
        if (!lounge.botserv) lounge.botserv = { bot: '', fantasy: true, greet: '', dontkickops: true, dontkickvoices: false };
        if (!lounge.botserv.bot) lounge.botserv.bot = 'HelpBot';
      }
      this.ensureChannel('#ops');
      const ops = this.channels['#ops'];
      ops.registered = true;
      ops.modes.n = true;
      ops.modes.t = true;
      ops.topic = ops.topic || 'kicks, akills, ops — paper trail';
    } catch (err) {
      console.error('[StateStore] Error applying snapshot:', err.message);
    }
  }

  load() {
    if (fs.existsSync(SQLITE_FILE)) return;
    if (!fs.existsSync(DB_FILE)) {
      this.ensureChannel('#ops');
      return;
    }
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      this.applySnapshot(JSON.parse(raw));
      console.log('[StateStore] Loaded persistent state from db.json (will migrate to sqlite)');
    } catch (err) {
      console.error('[StateStore] Error loading db.json:', err.message);
    }

    if (!this.channels['#lounge']) this.channels['#lounge'] = defaultChannel('#lounge', 'cozy lounge — idle, coffee, hellos');
    this.ensureChannel('#ops');
  }

  snapshot() {
    return {
      chat: this.chat,
      accounts: this.accounts,
      channels: this.channels,
      serverBans: this.serverBans,
      memos: this.memos,
      bots: this.bots,
      stats: this.stats,
      settings: this.settings,
      webNicks: this.webNicks
    };
  }

  save() {
    try {
      const json = JSON.stringify(this.snapshot());
      if (this._sqlDb && this._sqlFlush) {
        this._sqlDb.run('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', ['snapshot', json]);
        this._sqlFlush();
        return;
      }
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (err) {
      console.error('[StateStore] Error saving:', err.message);
    }
  }

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 400);
  }

  onChange() {
    this.scheduleSave();
    for (const cb of this.listeners) {
      try { cb(); } catch {}
    }
  }

  subscribe(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  ensureChannel(name, founder = 'shrc') {
    const key = normalizeChannel(name);
    if (!this.channels[key]) {
      this.channels[key] = defaultChannel(key, '', {
        topicBy: founder,
        ops: founder && founder !== 'shrc' ? [founder.toLowerCase()] : [],
        founder: founder && founder !== 'shrc' ? founder.toLowerCase() : '',
        modes: { n: true, t: true, m: false, i: false, s: false, k: '', l: 0 }
      });
    }
    if (!this.chat[key]) this.chat[key] = [];
    return normalizeChanRecord(this.channels[key]);
  }

  getMemos(nick) {
    const key = String(nick || '').toLowerCase();
    if (!this.memos[key]) this.memos[key] = [];
    return this.memos[key];
  }

  addMemo(to, from, text) {
    const list = this.getMemos(to);
    list.push({
      id: list.length + 1,
      from,
      text: String(text || '').slice(0, 400),
      time: Date.now(),
      unread: true
    });
    this.onChange();
    return list[list.length - 1];
  }

  registerNick(nickname, password, email, fingerprint) {
    const key = nickname.toLowerCase();
    if (this.accounts[key]) {
      return { success: false, message: `Nickname '${nickname}' is already registered.` };
    }
    const anyOper = Object.values(this.accounts).some((a) => a.isOper);
    this.accounts[key] = {
      nickname,
      passwordHash: hashPassword(password),
      fingerprint,
      email: email || '',
      registeredAt: Date.now(),
      isOper: !anyOper,
      ajoin: [],
      ignores: [],
      watch: [],
      lastSeen: Date.now()
    };
    this.onChange();
    const operNote = !anyOper ? ' You are the first registered nick — network oper granted.' : '';
    return { success: true, message: `Nickname '${nickname}' is now registered with NickServ.${operNote}` };
  }

  identifyNick(nickname, password) {
    const key = nickname.toLowerCase();
    const account = this.accounts[key];
    if (!account) {
      return { success: false, message: `Nickname '${nickname}' is not registered with NickServ.` };
    }
    if (!verifyPassword(password, account.passwordHash)) {
      return { success: false, message: `Invalid password for nickname '${nickname}'.` };
    }
    if (!String(account.passwordHash || '').startsWith('scrypt$')) {
      account.passwordHash = hashPassword(password);
    }
    account.lastSeen = Date.now();
    if (!account.ajoin) account.ajoin = [];
    if (!account.ignores) account.ignores = [];
    if (!account.watch) account.watch = [];
    this.scheduleSave();
    return {
      success: true,
      message: `Password accepted for '${nickname}'. You are now identified.`,
      account
    };
  }

  dropNick(nickname, password) {
    const key = nickname.toLowerCase();
    const account = this.accounts[key];
    if (!account) return { success: false, message: `Nickname '${nickname}' is not registered.` };
    if (!verifyPassword(password, account.passwordHash)) {
      return { success: false, message: 'Invalid password.' };
    }
    delete this.accounts[key];
    this.onChange();
    return { success: true, message: `Nickname '${nickname}' has been dropped from NickServ.` };
  }

  isNickProtected(nickname) {
    return !!this.accounts[String(nickname || '').toLowerCase()];
  }

  getAccount(nickname) {
    return this.accounts[String(nickname || '').toLowerCase()] || null;
  }

  setOper(nickname, isOper) {
    const acc = this.getAccount(nickname);
    if (!acc) return false;
    acc.isOper = !!isOper;
    this.onChange();
    return true;
  }

  addChatMessage(room, author, fingerprint, text, extra = {}) {
    const key = room.startsWith('query:') ? room : normalizeChannel(room);
    if (!this.chat[key]) this.chat[key] = [];
    const account = this.accounts[String(author || '').toLowerCase()];
    const msg = {
      id: 'msg-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
      type: extra.type || 'privmsg',
      room: key,
      author,
      fingerprint,
      text,
      timestamp: Date.now(),
      tags: {
        time: new Date().toISOString(),
        account: account ? account.nickname : '*'
      },
      extra: extra.extra || undefined
    };
    this.chat[key].push(msg);
    const cap = key.startsWith('query:') ? 200 : 250;
    if (this.chat[key].length > cap) {
      this.chat[key].splice(0, this.chat[key].length - cap);
    }
    this.onChange();
    return msg;
  }

  addServerBan(ban) {
    const row = {
      id: 'ban-' + crypto.randomBytes(4).toString('hex'),
      type: ban.type,
      value: String(ban.value || '').toLowerCase(),
      reason: ban.reason || 'no reason',
      setBy: ban.setBy || 'oper',
      setAt: Date.now()
    };
    this.serverBans = this.serverBans.filter((b) => !(b.type === row.type && b.value === row.value));
    this.serverBans.push(row);
    this.onChange();
    return row;
  }

  removeServerBan(type, value) {
    const v = String(value || '').toLowerCase();
    const before = this.serverBans.length;
    this.serverBans = this.serverBans.filter((b) => !(b.type === type && b.value === v));
    if (this.serverBans.length !== before) this.onChange();
    return this.serverBans.length !== before;
  }
}

export function normalizeChannel(name) {
  let n = String(name || '').trim();
  if (!n) return '#lounge';
  if (!n.startsWith('#')) n = '#' + n;
  return n.toLowerCase().replace(/[, ]/g, '').slice(0, 32);
}

export function isValidNick(nick) {
  return /^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,15}$/.test(String(nick || ''));
}

export const state = new StateStore();

try {
  const initSqlJs = (await import('sql.js')).default;
  const wasmFile = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const wasmBinary = fs.readFileSync(wasmFile);
  const SQL = await initSqlJs({ wasmBinary });
  const existed = fs.existsSync(SQLITE_FILE);
  const db = existed
    ? new SQL.Database(new Uint8Array(fs.readFileSync(SQLITE_FILE)))
    : new SQL.Database();
  state.attachSql(db, () => {
    const tmp = SQLITE_FILE + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, SQLITE_FILE);
  });
  if (!existed) state.save();
} catch (err) {
  console.error('[StateStore] sqlite unavailable, using json:', err.message);
}
