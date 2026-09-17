# shrc

Anonymous IRC over SSH (and a web terminal). Anope-style services.

```bash
npm install
node server/index.js
ssh localhost -p 2222
```

Web client: http://localhost:3000

## Identity

- New connections get `Guest######`
- `ssh Frank@host` claims Frank
- Registering a nick stores your SSH key fingerprint. Reconnecting with that key auto-identifies
- Taking a registered nick without identifying: 30 seconds, then you are renamed

## Services

| Command | Service |
|---|---|
| `/ns` | NickServ — register, identify, ghost, ajoin |
| `/cs` | ChanServ — register channels, flags `F A O H V`, akick |
| `/ms` | MemoServ — send / read / del |
| `/os` | OperServ — kill, akill, global (opers) |

Channel prefixes: `~` founder  `&` admin  `@` op  `%` halfop  `+` voice

Flags persist. After reconnect + identify (or SSH key login), status is restored.

End3r is a network oper and founder of `#lounge`.
