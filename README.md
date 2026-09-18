# shrc

shrc is a small IRC network you reach over SSH (or a browser terminal). Guests are allowed. Nicks, channels, ops, and vhosts are handled by Anope-style services. There is no signup form: you connect, pick a nick, and talk.

It is IRC first. There is no radio, games, or canvas — just channels, queries, and services.

## Requirements

- Node.js 18+
- An SSH client, or a browser for the web terminal

## Quick start

```bash
git clone https://github.com/lord3nd3r/SHRC.git
cd SHRC
npm install
node server/index.js
```

That starts:

| Service | Default |
|---|---|
| HTTP + web terminal | http://localhost:3000 |
| SSH IRC | `ssh localhost -p 2222` |

Override ports with `PORT` and `SSH_PORT`. Set `SHRC_OPER_PASSWORD` if you want a network-wide oper password that is not a NickServ password.

```bash
PORT=8080 SSH_PORT=2222 SHRC_OPER_PASSWORD=secret node server/index.js
```

The companion launcher in `cli/` is optional. It is a thin wrapper around `ssh`. Plain OpenSSH is enough:

```bash
ssh localhost -p 2222
ssh frank@localhost -p 2222
```

## Connecting

**Web.** Open `/`, click the web client. You land as `Guest` plus six digits. The socket is not opened until the terminal modal is open, so idle visitors are not counted as online.

**SSH.** The server accepts public keys (preferred) and, if you have no key, anonymous `none` auth.

- `ssh host -p 2222` → `Guest######`
- `ssh frank@host -p 2222` → nick `frank` (if it is free)
- Usernames `root`, `git`, `anonymous`, and `anon` are treated as guests

SSH identity is the **key**, not the password. The first `none` probe is rejected so OpenSSH actually sends a public key. The fingerprint is stored as `SHA256:…`.

Ctrl+C or `/quit` disconnects. `qq` on an empty-looking input also quits.

## Identity

New people are guests. You do not need an account to idle or speak, unless you take a **registered** nick.

| Action | What happens |
|---|---|
| `/nick alice` | Change nick. If `alice` is free and unregistered, it is yours for this session. |
| `/nick alice` when alice is registered | Allowed. NickServ gives you **30 seconds** to `/identify`. Miss it and you are renamed to a Guest. |
| `/register secret [email]` | Bind the current nick to NickServ. |
| `/identify secret` | Identify as the current nick (`/id` works). |
| `/ns ghost alice secret` | Kill a stale session holding your nick, then take it. |
| Reconnect with the same SSH key | Auto-identified as the nick that key is bound to. |

The first time you `/identify` (or `/register`) over SSH, that key is written onto the account. You should see a notice that the key is bound. After that, reconnecting with the same key skips Guest and skips the 30-second window.

Web sessions use a throwaway `web:` fingerprint, so they always need `/identify`.

If you `ssh alice@host` to a registered nick **without** a bound key, you still get the nick and the 30-second clock. Identify once with that key to bind it.

The first registered nick on a fresh database is granted network oper. After that, opers are made with `/opergrant` or OperServ.

## The client

The TUI is a single-screen IRC client (irssi-shaped):

- Left: buffers (`*server*`, channels, queries). Unread is a yellow dot. Ctrl+N / Ctrl+P cycle. Click a buffer to switch.
- Center: messages, newest at the bottom. PgUp / PgDn or the wheel for scrollback. Mentions of your nick highlight.
- Right: names list on channels. Prefixes are coloured. Click a nick to open a query.
- Bottom: `[#channel] input` — `@` / `~` etc. show your status. Passwords on `/identify`, `/register`, `/oper`, `/ghost`, `/drop` are masked.

Tab completes nicks and channels. Up/down is input history.

`/help` prints the command list inside the client.

## Everyday IRC

```
/join #linux
/join #secret hunter2          channel key
/part [#chan] [message]
/msg alice hello               private message (they must be online)
/query alice                   open a query window
/notice alice hi
/me waves
/topic [#chan] [text]
/names  /who  /whois alice
/list
/away [message]
/invite alice [#chan]
/ignore alice
/unignore alice
/motd  /ping  /clear  /cycle
/quit [message]
```

Ignore is per session: it dies when you disconnect.

Queries only open if the other nick is online. For offline mail use MemoServ.

Channel modes (ops): `+n` no external messages, `+t` topic ops only, `+m` moderated, `+i` invite only, `+k` key, `+l` limit, `+s` secret, `+b` ban, `+o` / `+v` status.

```
/mode #linux
/mode #linux +m
/mode #linux +b nick
```

## Channel status

Live prefixes, highest first:

| Prefix | Meaning |
|---|---|
| `~` | founder |
| `&` | admin / protect (SOP) |
| `@` | op (AOP) |
| `%` | halfop (HOP) |
| `+` | voice (VOP) |

On an **unregistered** channel, the first joiner is op. That op is live only; it does not survive an empty channel the way ChanServ flags do.

On a **registered** channel, flags on the access list are restored when that person identifies (or SSH-key auto-identifies). `/op` and `/voice` from SOP/founder also write flags so they stick.

```
/op alice
/deop alice
/voice bob
/devoice bob
/hop carol
/kick alice [reason]
/ban alice
/unban alice
```

You cannot deop a founder unless you are a network oper.

## Services

All of these accept `/msg ServiceName COMMAND` as well as the short slash form. `/ns help`, `/cs help`, and so on print the service’s own help.

### NickServ — `/ns`

```
/ns register <password> [email]
/ns identify <password>          (also /identify, /id)
/ns logout
/ns ghost <nick> <password>
/ns recover <nick> <password>
/ns drop <password>
/ns info [nick]
/ns set password <new>
/ns set email <addr>
/ns ajoin add|del|list [#chan]
```

AJOIN channels are joined automatically after identify.

### ChanServ — `/cs`

Register a channel you are opped in:

```
/cs register [#chan] [description]
/cs drop [#chan]                 founder or oper
/cs info [#chan]
/cs list
/cs flags [#chan] [nick +FAOHV]
/cs sop|aop|hop|vop add|del|list [nick]
/cs op|deop|voice|devoice|halfop [#chan] [nick]
/cs akick add|del|list [#chan] [mask] [reason]
/cs topic [#chan] [text]
/cs set [#chan] founder|desc|entrymsg|url|email|mlock|keeptopic|secure|restricted
/cs sync [#chan]
```

Flags:

| Flag | Rank |
|---|---|
| `F` | founder |
| `A` | admin / SOP |
| `O` | auto-op |
| `H` | halfop |
| `V` | voice |

`SECURE` (default on) means unidentified people do not get their flags. `RESTRICTED` means only the access list (and opers) may join.

Default public rooms on a new install: `#lounge`, `#linux`, `#dev`, `#general`, `#random`. `#lounge` is registered so founder/op can persist; you can `/cs drop` or `/cs set founder` as you like.

### MemoServ — `/ms`

Offline messages to a **registered** nick:

```
/ms send <nick> <text>
/ms list
/ms read [num]
/ms del <num|all>
```

You are told about unread memos when you identify.

### OperServ — `/os`

Network opers only (`/oper` after your account has `isOper`, or `SHRC_OPER_PASSWORD`):

```
/os kill <nick> [reason]
/os akill add <nick|ip|fp> [reason]
/os akill del <target>
/os akill list
/os global <text>
/os mode <#chan> <modes>
/os oper add|del <nick>
```

Client aliases: `/kill`, `/akill`, `/kline`, `/unkline`, `/klines`, `/opergrant`, `/deoper`, `/wallops`.

`/akill` is a network ban plus disconnect. Bots cannot be `/kill`’d — unassign or `/bs bot del` them.

### BotServ — `/bs`

Bots are extra nicks that sit in registered channels. They are not counted in the “online” badge.

A default bot named `HelpBot` is assigned to `#lounge` with fantasy on.

```
/bs bot list
/bs bot add <nick> [ident [host [realname]]]     opers
/bs bot del <nick>                               opers
/bs assign <#chan> <bot>                         SOP/founder
/bs unassign [#chan]
/bs say <#chan> <text>
/bs act <#chan> <text>
/bs info [#chan]
/bs set [#chan] fantasy|dontkickops|dontkickvoices|greet ...
```

Greet accepts `%n` (nick) and `%c` (channel).

Fantasy (in-channel, if FANTASY is on) uses **your** ChanServ access, not the bot’s:

```
!op nick    !deop nick
!voice nick !devoice nick
!hop nick
!kick nick [reason]
!ban nick   !unban nick
!topic text
```

`DONTKICKOPS` (default on) stops the bot kicking ops.

### HostServ — `/hs`

Vhosts replace your IP in `/who` and `/whois` (`nick!ident@vhost`).

```
/hs request <vhost>          you ask
/hs on                       enable
/hs off                      show real host again
/hs info [nick]
/hs set <nick> <vhost>       opers, immediate
/hs del <nick>               opers
/hs list                     opers
/hs waiting                  opers, pending requests
/hs activate <nick>          opers, approve
/hs reject <nick> [reason]   opers
```

Vhosts look like hostnames: `alice.users.shrc`.

## Persistence

State lives in `data/db.json` (chat, accounts, channels, flags, memos, bots, bans). The SSH **host** private key is `data/host_key` (generated on first run as ed25519). Neither file is in git.

Writes are debounced and replaced atomically (`db.json.tmp` → `db.json`).

Chat is capped per room. The artboard and profile directory from earlier experiments are gone.

## Layout

```
server/index.js         HTTP, Socket.IO, static files, web sessions
server/ssh-server.js    SSH listener, key fingerprints
server/irc.js           network: nicks, channels, modes, fantasy
server/services.js      NickServ ChanServ MemoServ OperServ BotServ HostServ
server/state.js         JSON store
server/tui-engine.js    terminal UI
src/                    landing page + xterm client
cli/                    optional ssh launcher
data/                   runtime db + host key (not committed)
```

Static HTTP only serves `/`, `/src`, and `/install.sh`. The rest of the tree is not exposed.

## License

MIT
