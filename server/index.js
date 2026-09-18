import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';

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
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const HTTP_PORT = process.env.PORT || 3000;
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
  const activeCount = irc.clients.size;
  const rooms = irc.occupiedChannelCount();
  res.send(`<span class="live-dot"></span>${activeCount} online · ${rooms} channel${rooms === 1 ? '' : 's'}`);
});

app.get('/api/status', (req, res) => {
  res.json({
    online: irc.clients.size,
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

function socketIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return socket.handshake.address || '0.0.0.0';
}

io.on('connection', (socket) => {
  const ip = socketIp(socket);
  const fingerprint = 'web:' + socket.id;
  const ban = irc.checkBan({ fingerprint, ip, nick: '' });
  if (ban) {
    socket.emit('terminal:output', `\r\n banned from shrc (${ban.reason})\r\n`);
    socket.disconnect(true);
    return;
  }

  const webUser = {
    username: null,
    fingerprint,
    ip
  };

  const virtualStream = {
    writable: true,
    columns: 90,
    rows: 30,
    write: (data) => {
      socket.emit('terminal:output', data);
    },
    end: () => {
      socket.emit('terminal:output', '\r\n');
      socket.disconnect(true);
    },
    disconnectSocket: () => socket.disconnect(true)
  };

  let session = null;

  socket.on('terminal:start', ({ cols, rows } = {}) => {
    if (session) session.destroy();
    virtualStream.columns = cols || 90;
    virtualStream.rows = rows || 30;
    session = new TUISession(virtualStream, webUser);
    session.handleResize(virtualStream.columns, virtualStream.rows);
  });

  socket.on('terminal:input', (data) => {
    if (session && session.alive) session.handleInput(Buffer.from(data));
  });

  socket.on('terminal:resize', ({ cols, rows }) => {
    virtualStream.columns = cols;
    virtualStream.rows = rows;
    if (session && session.alive) session.handleResize(cols, rows);
  });

  socket.on('disconnect', () => {
    if (session) session.destroy();
    session = null;
  });
});

irc.bootBots();

createSSHServer(SSH_PORT);

server.listen(HTTP_PORT, () => {
  console.log(`[HTTP Server] Listening on http://localhost:${HTTP_PORT}`);
  console.log(`[HTTP Server] Web terminal ready`);
});
