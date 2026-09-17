import { state, normalizeChannel, isValidNick, hashPassword, verifyPassword } from './state.js';

function lower(s) {
  return String(s || '').toLowerCase();
}

function sanitize(text, max = 400) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\r\n|\n|\r/g, ' ')
    .slice(0, max);
}

function notices(service, lines) {
  return {
    ok: true,
    error: null,
    status: '',
    lines: lines.map((text) => ({ type: 'notice', author: service, text, timestamp: Date.now() })),
    switchBuffer: null,
    quit: false,
    reason: '',
    openQuery: null
  };
}

function fail(service, error) {
  return {
    ok: false,
    error: '',
    status: '',
    lines: [{ type: 'notice', author: service, text: error, timestamp: Date.now() }],
    switchBuffer: null,
    quit: false,
    reason: '',
    openQuery: null
  };
}

const RANK = { F: 50, A: 40, O: 30, H: 20, V: 10 };

export function flagRank(flags) {
  let best = 0;
  for (const c of String(flags || '')) best = Math.max(best, RANK[c] || 0);
  return best;
}

export function splitArgs(text) {
  const raw = String(text || '').trim();
  if (!raw) return { cmd: '', rest: '', args: [] };
  const sp = raw.indexOf(' ');
  const cmd = (sp === -1 ? raw : raw.slice(0, sp)).toLowerCase();
  const rest = (sp === -1 ? '' : raw.slice(sp + 1)).trim();
  const args = rest.length ? rest.split(/\s+/) : [];
  return { cmd, rest, args };
}

export function handleService(irc, client, buffer, service, text) {
  const name = service[0].toUpperCase() + service.slice(1).toLowerCase();
  if (name === 'Nickserv') return nickServ(irc, client, buffer, text);
  if (name === 'Chanserv') return chanServ(irc, client, buffer, text);
  if (name === 'Memoserv') return memoServ(irc, client, buffer, text);
  if (name === 'Operserv') return operServ(irc, client, buffer, text);
  if (name === 'Botserv') return botServ(irc, client, buffer, text);
  return fail('shrc', 'No such service.');
}

function needIdent(client, svc) {
  if (client.identified && lower(client.account) === lower(client.nick)) return null;
  return fail(svc, 'You must be identified to a registered nick. /ns identify <password>');
}

function nickServ(irc, client, buffer, text) {
  const { cmd, rest, args } = splitArgs(text);
  const S = 'NickServ';
  if (!cmd || cmd === 'help') {
    return notices(S, [
      'REGISTER <password> [email]  register this nick',
      'IDENTIFY <password>          identify (alias /id)',
      'LOGOUT                       drop identification',
      'GHOST <nick> <password>      disconnect a stale session',
      'RECOVER <nick> <password>    ghost + take the nick',
      'DROP <password>              unregister this nick',
      'INFO [nick]                  account info',
      'SET PASSWORD <new>           change password',
      'SET EMAIL <addr>             set email',
      'AJOIN ADD|DEL|LIST [#chan]   autojoin on identify',
      'Your SSH key is remembered. Reconnect with the same key to auto-identify.'
    ]);
  }

  switch (cmd) {
    case 'register':
      return irc.exec(client, buffer, '/register ' + rest);
    case 'identify':
    case 'id':
      return irc.exec(client, buffer, '/identify ' + rest);
    case 'logout':
      client.identified = false;
      client.account = null;
      client.oper = false;
      return notices(S, ['You have been logged out.']);
    case 'ghost':
      return irc.exec(client, buffer, '/ghost ' + rest);
    case 'recover':
    case 'release': {
      if (args.length < 2) return fail(S, 'Syntax: RECOVER <nick> <password>');
      const g = irc.exec(client, buffer, '/ghost ' + rest);
      if (!g.ok && g.error) return g;
      return g;
    }
    case 'drop':
      return irc.exec(client, buffer, '/drop ' + rest);
    case 'info': {
      const nick = args[0] || client.nick;
      const acc = state.getAccount(nick);
      if (!acc) return fail(S, `Nick ${nick} is not registered.`);
      const online = irc.findNick(nick);
      const lines = [
        `${acc.nickname} is registered`,
        `Registered: ${new Date(acc.registeredAt).toISOString()}`,
        acc.email && client.oper ? `Email: ${acc.email}` : 'Email: (hidden)',
        acc.isOper ? 'Status: network operator' : 'Status: user',
        online ? `Online as ${online.nick}${online.identified ? ' (identified)' : ''}` : 'Currently offline'
      ];
      if (client.oper) lines.push(`Fingerprint: ${acc.fingerprint || '(none)'}`);
      return notices(S, lines);
    }
    case 'set': {
      const err = needIdent(client, S);
      if (err) return err;
      const what = lower(args[0]);
      const val = args.slice(1).join(' ');
      const acc = state.getAccount(client.account);
      if (!acc) return fail(S, 'No account.');
      if (what === 'password') {
        if (!val) return fail(S, 'Syntax: SET PASSWORD <new>');
        acc.passwordHash = hashPassword(val);
        state.onChange();
        return notices(S, ['Password changed.']);
      }
      if (what === 'email') {
        acc.email = val;
        state.onChange();
        return notices(S, [`Email set to ${val || '(none)'}`]);
      }
      return fail(S, 'SET PASSWORD | SET EMAIL');
    }
    case 'ajoin': {
      const err = needIdent(client, S);
      if (err) return err;
      const acc = state.getAccount(client.account);
      if (!acc.ajoin) acc.ajoin = [];
      const sub = lower(args[0]);
      if (sub === 'list' || !sub) {
        return notices(S, acc.ajoin.length ? acc.ajoin.map((c) => `AJOIN: ${c}`) : ['AJOIN list is empty.']);
      }
      if (sub === 'add') {
        const ch = normalizeChannel(args[1] || buffer);
        if (!acc.ajoin.includes(ch)) acc.ajoin.push(ch);
        state.onChange();
        return notices(S, [`${ch} added to your AJOIN list.`]);
      }
      if (sub === 'del' || sub === 'del' || sub === 'delete') {
        const ch = normalizeChannel(args[1] || buffer);
        acc.ajoin = acc.ajoin.filter((c) => c !== ch);
        state.onChange();
        return notices(S, [`${ch} removed from your AJOIN list.`]);
      }
      return fail(S, 'Syntax: AJOIN ADD|DEL|LIST [#channel]');
    }
    default:
      return fail(S, 'Unknown command. /ns help');
  }
}

function chanOf(args, buffer, i = 0) {
  if (args[i] && args[i].startsWith('#')) return { chan: normalizeChannel(args[i]), resti: i + 1 };
  if (buffer && buffer.startsWith('#')) return { chan: normalizeChannel(buffer), resti: i };
  return { chan: '', resti: i };
}

function chanServ(irc, client, buffer, text) {
  const { cmd, rest, args } = splitArgs(text);
  const S = 'ChanServ';
  if (!cmd || cmd === 'help') {
    return notices(S, [
      'REGISTER [#chan] [description]  register a channel (you become founder)',
      'DROP [#chan]                    drop registration (founder/oper)',
      'INFO [#chan]                    channel info + flags',
      'LIST                            registered channels',
      'FLAGS [#chan] [nick +FOAHV]     set access flags',
      '  F founder  A admin/protect  O op  H halfop  V voice',
      'SOP|AOP|HOP|VOP ADD|DEL|LIST [nick]',
      'OP|DEOP|VOICE|DEVOICE|HALFOP [#chan] [nick]',
      'AKICK ADD|DEL|LIST [#chan] [mask] [reason]',
      'TOPIC [#chan] [text]            set topic',
      'SET [#chan] FOUNDER|DESC|ENTRYMSG|SECURE|RESTRICTED|KEEPTOPIC|MLOCK',
      'SYNC [#chan]                    re-apply flags to everyone in channel',
      'Access is restored when the person reconnects and identifies (SSH key auto-identifies).'
    ]);
  }

  switch (cmd) {
    case 'register': {
      const err = needIdent(client, S);
      if (err) return err;
      const { chan } = chanOf(args, buffer, 0);
      if (!chan) return fail(S, 'Join a channel first, then /cs register');
      if (!client.channels.has(chan) && !client.oper) return fail(S, `You are not on ${chan}.`);
      const ch = state.ensureChannel(chan);
      if (ch.registered) return fail(S, `${chan} is already registered to ${ch.founder || 'someone'}.`);
      if (!irc.isOp(client, chan) && !client.oper) return fail(S, 'You must be op in the channel to register it.');
      const desc = args[0] && args[0].startsWith('#') ? args.slice(1).join(' ') : rest;
      ch.registered = true;
      ch.founder = lower(client.account);
      ch.flags[lower(client.account)] = 'F';
      ch.settings.desc = sanitize(desc, 120);
      irc.applyAccess(client, chan);
      state.onChange();
      return notices(S, [`${chan} is now registered to ${client.nick}. You are founder (~).`]);
    }
    case 'drop': {
      const err = needIdent(client, S);
      if (err) return err;
      const { chan } = chanOf(args, buffer, 0);
      if (!chan) return fail(S, 'Syntax: DROP [#channel]');
      const ch = state.channels[chan];
      if (!ch?.registered) return fail(S, `${chan} is not registered.`);
      if (ch.founder !== lower(client.account) && !client.oper) return fail(S, 'Only the founder or a network oper can drop this channel.');
      ch.registered = false;
      ch.flags = {};
      ch.akick = [];
      ch.founder = '';
      state.onChange();
      return notices(S, [`${chan} has been dropped.`]);
    }
    case 'info': {
      const { chan } = chanOf(args, buffer, 0);
      if (!chan) return fail(S, 'Syntax: INFO [#channel]');
      const ch = state.channels[chan];
      if (!ch) return fail(S, 'No such channel.');
      if (!ch.registered) return notices(S, [`${chan} is not registered. An op can /cs register.`]);
      const flagLines = Object.entries(ch.flags || {}).map(([n, f]) => `  ${n}  +${f}`);
      return notices(S, [
        `${chan} is registered to ${ch.founder}`,
        `Description: ${ch.settings.desc || '(none)'}`,
        `Topic: ${ch.topic || '(none)'}`,
        `Options: keeptopic=${ch.settings.keeptopic} secure=${ch.settings.secure} restricted=${ch.settings.restricted}`,
        `MLOCK: ${ch.settings.mlock || '+nt'}`,
        'Access list:',
        ...(flagLines.length ? flagLines : ['  (empty)'])
      ]);
    }
    case 'list': {
      const rows = Object.values(state.channels)
        .filter((c) => c.registered)
        .map((c) => `${c.name}  founder ${c.founder}  ${c.settings?.desc || ''}`);
      return notices(S, rows.length ? rows : ['No registered channels.']);
    }
    case 'flags': {
      const err = needIdent(client, S);
      if (err) return err;
      const { chan, resti } = chanOf(args, buffer, 0);
      if (!chan) return fail(S, 'Syntax: FLAGS [#chan] [nick +FOAHV]');
      const ch = state.ensureChannel(chan);
      if (!ch.registered) return fail(S, `${chan} is not registered.`);
      const nick = args[resti];
      const spec = args[resti + 1];
      if (!nick) {
        const rows = Object.entries(ch.flags || {}).map(([n, f]) => `${n} +${f}`);
        return notices(S, rows.length ? rows : [`No flags on ${chan}.`]);
      }
      if (!spec) {
        return notices(S, [`${nick} flags on ${chan}: +${ch.flags[lower(nick)] || '(none)'}`]);
      }
      const myRank = irc.accessRank(client, chan);
      if (myRank < RANK.A && !client.oper) return fail(S, 'You need AOP/SOP/founder to edit flags.');
      const res = irc.setFlags(client, chan, nick, spec);
      return res.ok ? notices(S, [res.status]) : fail(S, res.error || res.lines?.[0]?.text || 'Failed.');
    }
    case 'sop':
    case 'aop':
    case 'hop':
    case 'vop': {
      const flag = { sop: 'A', aop: 'O', hop: 'H', vop: 'V' }[cmd];
      const sub = lower(args[0]);
      const { chan, resti } = args[1] && args[1].startsWith('#')
        ? { chan: normalizeChannel(args[1]), resti: 2 }
        : chanOf(args.slice(1), buffer, 0);
      const nick = args[0] && !['add', 'del', 'list', 'delete'].includes(sub) ? args[0] : args[resti];
      if (sub === 'list' || (!sub && !nick)) {
        const ch = state.channels[chan];
        if (!ch?.registered) return fail(S, 'Channel is not registered.');
        const rows = Object.entries(ch.flags || {}).filter(([, f]) => f.includes(flag)).map(([n, f]) => `${n} +${f}`);
        return notices(S, rows.length ? rows : [`No ${cmd.toUpperCase()} entries.`]);
      }
      if (sub === 'add' || (!['del', 'delete', 'list'].includes(sub) && nick)) {
        return irc.setFlags(client, chan, nick || args[resti], '+' + flag);
      }
      if (sub === 'del' || sub === 'delete') {
        return irc.setFlags(client, chan, nick, '-' + flag);
      }
      return fail(S, `Syntax: ${cmd.toUpperCase()} ADD|DEL|LIST [nick]`);
    }
    case 'op':
    case 'deop':
    case 'voice':
    case 'devoice':
    case 'halfop':
    case 'dehalfop':
    case 'protect':
    case 'deprotect': {
      const { chan, resti } = chanOf(args, buffer, 0);
      const nick = args[resti] || client.nick;
      const give = !cmd.startsWith('de');
      const flag = cmd.includes('voice') ? 'V' : cmd.includes('half') ? 'H' : cmd.includes('protect') ? 'A' : 'O';
      if (give) return irc.setFlags(client, chan, nick, '+' + flag);
      return irc.setFlags(client, chan, nick, '-' + flag);
    }
    case 'akick': {
      const err = needIdent(client, S);
      if (err) return err;
      const sub = lower(args[0]);
      const { chan, resti } = args[1] && args[1].startsWith('#')
        ? { chan: normalizeChannel(args[1]), resti: 2 }
        : chanOf(args.slice(1), buffer, 0);
      const ch = state.ensureChannel(chan);
      if (!ch.registered) return fail(S, 'Channel is not registered.');
      if (irc.accessRank(client, chan) < RANK.A && !client.oper) return fail(S, 'Permission denied.');
      if (sub === 'list' || !sub) {
        const rows = (ch.akick || []).map((a) => `${a.mask}  (${a.reason}) by ${a.setBy}`);
        return notices(S, rows.length ? rows : ['AKICK list empty.']);
      }
      if (sub === 'add') {
        const mask = args[resti];
        if (!mask) return fail(S, 'Syntax: AKICK ADD <nick|mask> [reason]');
        const reason = args.slice(resti + 1).join(' ') || 'akick';
        ch.akick = ch.akick.filter((a) => lower(a.mask) !== lower(mask));
        ch.akick.push({ mask, reason: sanitize(reason, 80), setBy: client.nick, setAt: Date.now() });
        const t = irc.findNick(mask);
        if (t && t.channels.has(chan) && !t.oper) {
          irc.kick(client, chan, t.nick, reason);
        }
        state.onChange();
        return notices(S, [`AKICK added: ${mask}`]);
      }
      if (sub === 'del' || sub === 'delete') {
        const mask = args[resti];
        ch.akick = (ch.akick || []).filter((a) => lower(a.mask) !== lower(mask));
        state.onChange();
        return notices(S, [`AKICK removed: ${mask}`]);
      }
      return fail(S, 'Syntax: AKICK ADD|DEL|LIST');
    }
    case 'topic': {
      const { chan, resti } = chanOf(args, buffer, 0);
      const topic = args[0] && args[0].startsWith('#') ? args.slice(resti).join(' ') : rest;
      return irc.topic(client, chan, topic === '' ? null : topic);
    }
    case 'set': {
      const err = needIdent(client, S);
      if (err) return err;
      const { chan, resti } = chanOf(args, buffer, 0);
      const ch = state.channels[chan];
      if (!ch?.registered) return fail(S, 'Channel is not registered.');
      if (ch.founder !== lower(client.account) && !client.oper && irc.accessRank(client, chan) < RANK.A) {
        return fail(S, 'Permission denied.');
      }
      const what = lower(args[resti]);
      const val = args.slice(resti + 1).join(' ');
      if (what === 'founder') {
        if (ch.founder !== lower(client.account) && !client.oper) return fail(S, 'Only founder can SET FOUNDER.');
        if (!state.getAccount(val)) return fail(S, 'That nick is not registered.');
        delete ch.flags[ch.founder];
        ch.founder = lower(val);
        ch.flags[ch.founder] = 'F';
        state.onChange();
        return notices(S, [`Founder of ${chan} is now ${val}.`]);
      }
      if (what === 'desc' || what === 'description') { ch.settings.desc = sanitize(val, 120); state.onChange(); return notices(S, ['Description updated.']); }
      if (what === 'entrymsg') { ch.settings.entrymsg = sanitize(val, 160); state.onChange(); return notices(S, ['Entry message updated.']); }
      if (what === 'url') { ch.settings.url = val; state.onChange(); return notices(S, ['URL updated.']); }
      if (what === 'email') { ch.settings.email = val; state.onChange(); return notices(S, ['Email updated.']); }
      if (what === 'mlock') { ch.settings.mlock = val || '+nt'; state.onChange(); return notices(S, [`MLOCK ${ch.settings.mlock}`]); }
      if (['keeptopic', 'secure', 'restricted'].includes(what)) {
        const on = !/^(off|0|false|no)$/i.test(val || 'on');
        ch.settings[what] = on;
        state.onChange();
        return notices(S, [`${what.toUpperCase()} is now ${on ? 'ON' : 'OFF'}.`]);
      }
      return fail(S, 'SET FOUNDER|DESC|ENTRYMSG|URL|EMAIL|MLOCK|KEEPTOPIC|SECURE|RESTRICTED');
    }
    case 'sync': {
      const { chan } = chanOf(args, buffer, 0);
      if (!chan) return fail(S, 'Syntax: SYNC [#channel]');
      if (irc.accessRank(client, chan) < RANK.O && !client.oper) return fail(S, 'Permission denied.');
      for (const m of irc.members(chan)) irc.applyAccess(m, chan);
      state.onChange();
      return notices(S, [`Synchronized access on ${chan}.`]);
    }
    default:
      return fail(S, 'Unknown command. /cs help');
  }
}

function memoServ(irc, client, buffer, text) {
  const { cmd, rest, args } = splitArgs(text);
  const S = 'MemoServ';
  if (!cmd || cmd === 'help') {
    return notices(S, [
      'SEND <nick> <text>   send a memo to a registered nick',
      'LIST                 list your memos',
      'READ [num]           read a memo (or next unread)',
      'DEL <num|ALL>        delete'
    ]);
  }
  const ident = needIdent(client, S);
  if (ident && cmd !== 'help') return ident;
  const box = state.getMemos(client.account);

  switch (cmd) {
    case 'send': {
      if (args.length < 2) return fail(S, 'Syntax: SEND <nick> <text>');
      const dest = args[0];
      if (!state.getAccount(dest)) return fail(S, `${dest} is not registered.`);
      const body = rest.slice(dest.length).trim();
      state.addMemo(dest, client.nick, body);
      const online = irc.findNick(dest);
      if (online?.identified && lower(online.account) === lower(dest)) {
        irc.pushService(online, S, [`You have a new memo from ${client.nick}. /ms read`]);
      }
      return notices(S, [`Memo sent to ${dest}.`]);
    }
    case 'list': {
      if (!box.length) return notices(S, ['You have no memos.']);
      return notices(S, box.map((m, i) => `${i + 1}. ${m.unread ? '*' : ' '} ${m.from}  ${new Date(m.time).toISOString()}  ${m.text.slice(0, 40)}`));
    }
    case 'read': {
      const n = args[0] ? parseInt(args[0], 10) : box.findIndex((m) => m.unread) + 1;
      const m = box[n - 1];
      if (!m) return fail(S, 'No such memo.');
      m.unread = false;
      state.onChange();
      return notices(S, [`Memo ${n} from ${m.from}:`, m.text]);
    }
    case 'del':
    case 'delete': {
      if (lower(args[0]) === 'all') {
        state.memos[lower(client.account)] = [];
        state.onChange();
        return notices(S, ['All memos deleted.']);
      }
      const n = parseInt(args[0], 10);
      if (!n || !box[n - 1]) return fail(S, 'Syntax: DEL <num|ALL>');
      box.splice(n - 1, 1);
      state.onChange();
      return notices(S, [`Memo ${n} deleted.`]);
    }
    default:
      return fail(S, 'Unknown command. /ms help');
  }
}

function operServ(irc, client, buffer, text) {
  const { cmd, rest, args } = splitArgs(text);
  const S = 'OperServ';
  if (!cmd || cmd === 'help') {
    return notices(S, [
      'KILL <nick> [reason]              disconnect a user',
      'AKILL ADD <nick|ip|fp> [reason]   network ban',
      'AKILL DEL <target>                lift a ban',
      'AKILL LIST',
      'GLOBAL <text>                     message all users',
      'MODE <#chan> <modes>              force channel modes',
      'OPER ADD|DEL <nick>               grant/revoke oper'
    ]);
  }
  if (!client.oper) return fail(S, 'Access denied.');

  switch (cmd) {
    case 'kill':
      return irc.exec(client, buffer, '/kill ' + rest);
    case 'akill': {
      const sub = lower(args[0]);
      if (sub === 'list' || !sub) return irc.exec(client, buffer, '/klines');
      if (sub === 'add') return irc.exec(client, buffer, '/akill ' + args.slice(1).join(' '));
      if (sub === 'del' || sub === 'delete') return irc.exec(client, buffer, '/unkline ' + args.slice(1).join(' '));
      return irc.exec(client, buffer, '/akill ' + rest);
    }
    case 'global': {
      if (!rest) return fail(S, 'Syntax: GLOBAL <text>');
      for (const c of irc.clients.values()) {
        irc.pushService(c, S, [`[GLOBAL] ${sanitize(rest, 200)}`]);
      }
      return notices(S, ['Global sent.']);
    }
    case 'mode': {
      if (args.length < 2) return fail(S, 'Syntax: MODE <#chan> <modes>');
      return irc.mode(client, args[0], args[1], args.slice(2));
    }
    case 'oper': {
      const sub = lower(args[0]);
      if (sub === 'add') return irc.exec(client, buffer, '/opergrant ' + args[1]);
      if (sub === 'del') return irc.exec(client, buffer, '/deoper ' + args[1]);
      return fail(S, 'Syntax: OPER ADD|DEL <nick>');
    }
    default:
      return fail(S, 'Unknown command. /os help');
  }
}

function botServ(irc, client, buffer, text) {
  const { cmd, rest, args } = splitArgs(text);
  const S = 'BotServ';
  if (!cmd || cmd === 'help') {
    return notices(S, [
      'BOT LIST                         list bots',
      'BOT ADD <nick> [ident [host [realname]]]   (opers) create a bot',
      'BOT DEL <nick>                   (opers) delete a bot',
      'ASSIGN <#chan> <bot>             put a bot in a registered channel',
      'UNASSIGN [#chan]                 remove the bot',
      'SAY <#chan> <text>               bot speaks',
      'ACT <#chan> <text>               bot emote',
      'INFO [#chan]                     assignment + fantasy settings',
      'SET [#chan] FANTASY|DONTKICKOPS|DONTKICKVOICES|GREET ...',
      'In channel: !op !deop !voice !kick !ban !topic  (if FANTASY is on)'
    ]);
  }

  switch (cmd) {
    case 'bot': {
      const sub = lower(args[0]);
      if (sub === 'list' || !sub) {
        const rows = Object.values(state.bots).map((b) => {
          const online = irc.findNick(b.nick);
          const chans = online ? [...online.channels].join(' ') : '(offline)';
          return `${b.nick}  ${b.ident}@${b.host}  ${chans}`;
        });
        return notices(S, rows.length ? rows : ['No bots. Add one with BOT ADD.']);
      }
      if (!client.oper) return fail(S, 'BOT ADD/DEL is for network opers.');
      if (sub === 'add') {
        const nick = args[1];
        if (!isValidNick(nick)) return fail(S, 'Syntax: BOT ADD <nick> [ident [host [realname]]]');
        if (state.bots[nick] || irc.findNick(nick)) return fail(S, 'That nick is already in use.');
        const ident = args[2] || 'bot';
        const host = args[3] || 'services.shrc';
        const realname = args.slice(4).join(' ') || 'a shrc bot';
        state.bots[nick] = { nick, ident, host, realname, createdBy: client.nick };
        irc.spawnBot(state.bots[nick]);
        state.onChange();
        return notices(S, [`Bot ${nick} created.`]);
      }
      if (sub === 'del' || sub === 'delete') {
        const nick = args[1];
        const def = state.bots[nick] || Object.values(state.bots).find((b) => lower(b.nick) === lower(nick));
        if (!def) return fail(S, 'No such bot.');
        const bot = irc.findNick(def.nick);
        if (bot) {
          for (const ch of [...bot.channels]) irc.botPart(bot, ch);
          irc.nicks.delete(lower(bot.nick));
          irc.clients.delete(bot.id);
        }
        for (const ch of Object.values(state.channels)) {
          if (ch.botserv && lower(ch.botserv.bot) === lower(def.nick)) ch.botserv.bot = '';
        }
        delete state.bots[def.nick];
        state.onChange();
        return notices(S, [`Bot ${def.nick} deleted.`]);
      }
      return fail(S, 'Syntax: BOT LIST|ADD|DEL');
    }
    case 'assign': {
      const err = needIdent(client, S);
      if (err) return err;
      if (args.length < 2) return fail(S, 'Syntax: ASSIGN <#chan> <bot>');
      const chan = normalizeChannel(args[0]);
      const botName = args[1];
      const ch = state.channels[chan];
      if (!ch?.registered) return fail(S, 'Channel must be registered first (/cs register).');
      if (irc.accessRank(client, chan) < 40 && !client.oper) return fail(S, 'You need SOP/founder to assign a bot.');
      const def = state.bots[botName] || Object.values(state.bots).find((b) => lower(b.nick) === lower(botName));
      if (!def) return fail(S, 'No such bot. /bs bot list');
      if (ch.botserv.bot && lower(ch.botserv.bot) !== lower(def.nick)) {
        const old = irc.findNick(ch.botserv.bot);
        if (old && old.isBot) irc.botPart(old, chan);
      }
      ch.botserv.bot = def.nick;
      const bot = irc.spawnBot(def);
      if (!bot) return fail(S, 'Could not spawn bot (nick in use by a person).');
      irc.botJoin(bot, chan);
      state.onChange();
      return notices(S, [`${def.nick} assigned to ${chan}. Fantasy: ${ch.botserv.fantasy ? 'ON' : 'OFF'}`]);
    }
    case 'unassign': {
      const err = needIdent(client, S);
      if (err) return err;
      const { chan } = chanOf(args, buffer, 0);
      if (!chan) return fail(S, 'Syntax: UNASSIGN [#chan]');
      const ch = state.channels[chan];
      if (!ch?.botserv?.bot) return fail(S, 'No bot assigned.');
      if (irc.accessRank(client, chan) < 40 && !client.oper) return fail(S, 'Permission denied.');
      const bot = irc.findNick(ch.botserv.bot);
      if (bot && bot.isBot) irc.botPart(bot, chan);
      ch.botserv.bot = '';
      state.onChange();
      return notices(S, [`Bot unassigned from ${chan}.`]);
    }
    case 'say': {
      if (args.length < 2) return fail(S, 'Syntax: SAY <#chan> <text>');
      const chan = normalizeChannel(args[0]);
      if (irc.accessRank(client, chan) < 30 && !client.oper) return fail(S, 'You need op access.');
      const said = irc.botSpeak(chan, args.slice(1).join(' '));
      return said.ok ? notices(S, ['Message sent.']) : fail(S, said.error);
    }
    case 'act': {
      if (args.length < 2) return fail(S, 'Syntax: ACT <#chan> <text>');
      const chan = normalizeChannel(args[0]);
      if (irc.accessRank(client, chan) < 30 && !client.oper) return fail(S, 'You need op access.');
      const said = irc.botSpeak(chan, args.slice(1).join(' '), 'action');
      return said.ok ? notices(S, ['Action sent.']) : fail(S, said.error);
    }
    case 'info': {
      const { chan } = chanOf(args, buffer, 0);
      if (!chan) return fail(S, 'Syntax: INFO [#chan]');
      const ch = state.channels[chan];
      if (!ch) return fail(S, 'No such channel.');
      const bs = ch.botserv || {};
      return notices(S, [
        `${chan} bot: ${bs.bot || '(none)'}`,
        `FANTASY: ${bs.fantasy !== false ? 'ON' : 'OFF'}  DONTKICKOPS: ${bs.dontkickops !== false ? 'ON' : 'OFF'}  DONTKICKVOICES: ${bs.dontkickvoices ? 'ON' : 'OFF'}`,
        `GREET: ${bs.greet || '(none)'}`
      ]);
    }
    case 'set': {
      const err = needIdent(client, S);
      if (err) return err;
      const { chan, resti } = chanOf(args, buffer, 0);
      const ch = state.channels[chan];
      if (!ch) return fail(S, 'No such channel.');
      if (irc.accessRank(client, chan) < 40 && !client.oper) return fail(S, 'Permission denied.');
      if (!ch.botserv) ch.botserv = { bot: '', fantasy: true, greet: '', dontkickops: true, dontkickvoices: false };
      const what = lower(args[resti]);
      const val = args.slice(resti + 1).join(' ');
      if (what === 'fantasy' || what === 'dontkickops' || what === 'dontkickvoices') {
        const on = !/^(off|0|false|no)$/i.test(val || 'on');
        ch.botserv[what] = on;
        state.onChange();
        return notices(S, [`${what.toUpperCase()} is now ${on ? 'ON' : 'OFF'}.`]);
      }
      if (what === 'greet') {
        ch.botserv.greet = sanitize(val, 160);
        state.onChange();
        return notices(S, [`Greet ${val ? 'set' : 'cleared'}. Use %n for nick, %c for channel.`]);
      }
      return fail(S, 'SET FANTASY|DONTKICKOPS|DONTKICKVOICES|GREET');
    }
    default:
      return fail(S, 'Unknown command. /bs help');
  }
}
