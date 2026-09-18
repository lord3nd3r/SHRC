# shrc

shrc is an **SSH clubhouse**. You `ssh` in (or open the web tty) and you are in a shared terminal: channels, nicks, ops, services. Guests are allowed. There is no signup form.

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

If `npm install` dies with `ENOENT ... mkdir .../node_modules/@...`, a previous failed install left a broken `node_modules`. Wipe it and try again:

```bash
rm -rf node_modules
git pull
npm install
```

That starts:

| Service | Default |
|---|---|
| HTTP + web terminal | http://localhost:3000 |
| SSH | `ssh localhost -p 2222` |

Override ports with `PORT` and `SSH_PORT`. Set `SHRC_OPER_PASSWORD` if you want a network-wide oper password that is not a NickServ password. Full SSH instructions for each OS are below and on `/connect`.

```bash
PORT=8080 SSH_PORT=2222 SHRC_OPER_PASSWORD=secret node server/index.js
```

The companion launcher in `cli/` is optional. It is a thin wrapper around `ssh`. Plain OpenSSH is enough:

```bash
ssh localhost -p 2222
ssh frank@localhost -p 2222
```

## How to connect

Replace `HOST` with the machine running shrc (`localhost` if it is on your computer). Default SSH port is **2222**. Default web port is **3000**.

You will not be asked for an SSH password. Identity is your **SSH public key** (or a guest id if you have no key). The first time a host key prompt appears, type `yes`.

Inside the session: `/nick alice`, `/join #lounge`, `/help`. Ctrl+C or `/quit` disconnects.

### Web (any OS)

Open `http://HOST:3000` (or the public site) and click **open the web client**. You land as `Guest######`. Web sessions do not bind an SSH key; `/identify` each time if you have a registered nick.

### Linux

OpenSSH is already there on current Ubuntu, Debian, Fedora, Arch, openSUSE, and most others.

```bash
# Ubuntu / Debian (only if ssh is missing)
sudo apt update && sudo apt install -y openssh-client

# Fedora / RHEL
sudo dnf install -y openssh-clients

# Arch
sudo pacman -S openssh
```

```bash
ssh HOST -p 2222                 # guest nick
ssh frank@HOST -p 2222           # claim nick "frank" if it is free
```

Optional key (recommended, binds to a registered nick after `/identify`):

```bash
ssh-keygen -t ed25519 -C "you@shrc"
# accept the default path: ~/.ssh/id_ed25519
ssh frank@HOST -p 2222
```

GNOME Terminal, Konsole, kitty, foot, or any terminal emulator is fine.

### macOS

Terminal.app (or iTerm2 / Ghostty / Kitty). OpenSSH ships with macOS. No extra install.

```bash
ssh HOST -p 2222
ssh frank@HOST -p 2222
ssh-keygen -t ed25519 -C "you@shrc"
```

Keys land in `~/.ssh/id_ed25519`. If macOS asks to store the key in Keychain, that is optional.

### Windows 11 and Windows 10 (1809+)

Use **OpenSSH in PowerShell** or **Windows Terminal**. This is the current Microsoft-supported client; you do not need PuTTY.

**1. Confirm OpenSSH Client** (preinstalled on Windows 11 and current Windows 10):

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Client*'
```

If `State` is not `Installed`, in an **elevated** PowerShell:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
```

Or: Settings → System → Optional features → Add → **OpenSSH Client**.

**2. Connect** from PowerShell, Windows Terminal, or Command Prompt:

```powershell
ssh HOST -p 2222
ssh frank@HOST -p 2222
```

**3. Key** (same as Unix; run in PowerShell):

```powershell
ssh-keygen -t ed25519 -C "you@shrc"
# default file: $env:USERPROFILE\.ssh\id_ed25519
ssh frank@HOST -p 2222
```

Windows Terminal is the default console on Windows 11 (Microsoft Store / built-in). Windows PowerShell 5.1 and PowerShell 7 both work; they call the same `ssh.exe`.

**WSL** (Ubuntu or another distro): follow the Linux section from the WSL shell.

**PuTTY** still works if you already use it: host `HOST`, port `2222`, connection type SSH. Auth is the `.ppk` key (PuTTYgen can convert `id_ed25519`). Prefer OpenSSH unless you have a reason not to.

### ChromeOS

Enable Linux (Crostini), open the Linux terminal, then use the Linux `ssh` commands above. The crosh `ssh` command is more limited; Crostini is the supported path.

### Android

[Termux](https://termux.dev/) (F-Droid or GitHub; the Play build is stale):

```bash
pkg install openssh
ssh frank@HOST -p 2222
```

JuiceSSH and Termius work too: host `HOST`, port `2222`, protocol SSH.

### iOS / iPadOS

There is no system `ssh` in Shortcuts. Use **Blink Shell**, **Termius**, or **Prompt**: host `HOST`, port `2222`, SSH. Blink: `ssh frank@HOST -p 2222`.

Usernames `root`, `git`, `anonymous`, and `anon` over SSH are treated as guests (`Guest######`).

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

After you SSH or open the web tty, you get a full-screen **text UI**:

- Left: buffers (`*server*`, channels, queries). Unread is a yellow dot. Ctrl+N / Ctrl+P cycle. Click a buffer to switch.
- Center: messages, newest at the bottom. PgUp / PgDn or the wheel for scrollback. Mentions of your nick highlight.
- Right: names list on channels. Prefixes are coloured. Click a nick to open a query.
- Bottom: `[#channel] input` — `@` / `~` etc. show your status. Passwords on `/identify`, `/register`, `/oper`, `/ghost`, `/drop` are masked.

Tab completes nicks and channels. Up/down is input history.

`/help` prints the command list inside the client.

## Commands

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
