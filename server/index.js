import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

import { state } from './state.js';
import { irc } from './irc.js';
import { TUISession } from './tui-engine.js';
import { createSSHServer } from './ssh-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const CLI_DIR = path.join(ROOT_DIR, 'cli');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });

const HTTP_PORT = process.env.PORT || 3000;
const HTTP_BIND = process.env.HTTP_BIND || '0.0.0.0';
const SSH_PORT = process.env.SSH_PORT || 2222;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use('/src', express.static(SRC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/connect', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'connect.html'));
});

app.get('/install.sh', (req, res) => {
  res.type('application/x-sh').sendFile(path.join(CLI_DIR, 'install.sh'));
});

app.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const activeCount = irc.humanCount();
  const rooms = irc.occupiedChannelCount();
  res.send(`<span class="live-dot"></span>${activeCount} online · ${rooms} channel${rooms === 1 ? '' : 's'}`);
});

app.get('/api/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    online: irc.humanCount(),
    totalConnections: state.stats.totalConnections,
    channels: irc.occupiedChannelCount()
  });
});

app.get('/api/channels', (req, res) => {
  const list = Object.values(state.channels)
    .filter((ch) => !ch.modes.s)
    .map((ch) => ({
      name: ch.name,
      topic: ch.topic,
      users: irc.members(ch.name).length
    }));
  res.json(list);
});

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || '0.0.0.0';
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const fingerprint = 'web:' + crypto.randomBytes(6).toString('hex');
  const ban = irc.checkBan({ fingerprint, ip, nick: '' });
  if (ban) {
    send(ws, { op: 'out', data: `\r\n banned from shrc (${ban.reason})\r\n` });
    ws.close();
    return;
  }

  const webUser = { username: null, fingerprint, ip };

  const virtualStream = {
    writable: true,
    columns: 90,
    rows: 30,
    write: (data) => {
      send(ws, { op: 'out', data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8') });
    },
    end: () => {
      send(ws, { op: 'out', data: '\r\n' });
      ws.close();
    },
    disconnectSocket: () => ws.close()
  };

  let session = null;
  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) {
      try { ws.ping(); } catch {}
      send(ws, { op: 'ping' });
    }
  }, 15000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.op === 'ping' || msg.op === 'pong') return;
    if (msg.op === 'start') {
      if (session) session.destroy();
      virtualStream.columns = msg.cols || 90;
      virtualStream.rows = msg.rows || 30;
      const id = String(msg.clientId || '').replace(/[^0-9a-f]/gi, '').slice(0, 32);
      webUser.fingerprint = id.length >= 16 ? 'web:' + id : webUser.fingerprint;
      webUser.username = msg.nick || null;
      webUser.hour12 = !!msg.hour12;
      webUser.beep = !!msg.beep;
      virtualStream.beep = () => send(ws, { op: 'hl' });
      session = new TUISession(virtualStream, webUser);
      session.handleResize(virtualStream.columns, virtualStream.rows);
    } else if (msg.op === 'in') {
      if (session && session.alive) session.handleInput(Buffer.from(msg.data || '', 'utf8'));
    } else if (msg.op === 'resize') {
      virtualStream.columns = msg.cols;
      virtualStream.rows = msg.rows;
      if (session && session.alive) session.handleResize(msg.cols, msg.rows);
    }
  });

  const drop = () => {
    clearInterval(heartbeat);
    if (session) session.destroy();
    session = null;
  };
  ws.on('close', drop);
  ws.on('error', drop);
});

irc.bootBots();

createSSHServer(SSH_PORT);

server.listen(HTTP_PORT, HTTP_BIND, () => {
  console.log(`[HTTP Server] Listening on http://${HTTP_BIND}:${HTTP_PORT}`);
  console.log(`[HTTP Server] Web terminal ready`);
});
