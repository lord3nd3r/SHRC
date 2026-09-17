import ssh2 from 'ssh2';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TUISession } from './tui-engine.js';

const { Server } = ssh2;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const HOST_KEY_PATH = path.join(DATA_DIR, 'host_key');

function getHostKey() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(HOST_KEY_PATH)) {
    console.log('[SSH Server] Generating new SSH host key...');
    const { privateKey } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    fs.writeFileSync(HOST_KEY_PATH, privateKey, 'utf-8');
  }

  return fs.readFileSync(HOST_KEY_PATH, 'utf-8');
}

function computeFingerprint(pubKeyBuffer) {
  const hash = crypto.createHash('sha256').update(pubKeyBuffer).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

function clientIp(client) {
  return client._sock?.remoteAddress
    || client.ip
    || '0.0.0.0';
}

function suggestedNick(username) {
  const u = String(username || '').trim();
  if (!u || u === 'root' || u === 'git' || u === 'anonymous' || u === 'anon') return null;
  return u.slice(0, 16);
}

export function createSSHServer(port = 2222) {
  const hostKey = getHostKey();

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    let authenticatedUser = null;
    const ip = clientIp(client);

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'none' && ctx.method !== 'publickey') {
        return ctx.reject(['publickey', 'none']);
      }

      let fp = 'anon:' + crypto.randomBytes(3).toString('hex');
      if (ctx.key && ctx.key.data) {
        fp = computeFingerprint(ctx.key.data);
      }

      const nick = suggestedNick(ctx.username);

      authenticatedUser = {
        username: nick,
        fingerprint: fp,
        ip
      };

      return ctx.accept();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let ptyCols = 80;
        let ptyRows = 24;
        let tuiSession = null;

        session.on('pty', (acceptPty, rejectPty, info) => {
          ptyCols = info.cols || 80;
          ptyRows = info.rows || 24;
          if (acceptPty) acceptPty();
        });

        session.on('shell', (acceptShell) => {
          const channel = acceptShell();
          tuiSession = new TUISession(channel, authenticatedUser || { ip, fingerprint: 'anon:' + crypto.randomBytes(3).toString('hex') });
          tuiSession.handleResize(ptyCols, ptyRows);

          session.on('window-change', (acceptWin, rejectWin, info) => {
            if (tuiSession && tuiSession.alive) tuiSession.handleResize(info.cols, info.rows);
            if (acceptWin) acceptWin();
          });

          channel.on('data', (data) => {
            if (tuiSession && tuiSession.alive) tuiSession.handleInput(data);
          });

          channel.on('close', () => {
            if (tuiSession) tuiSession.destroy();
            tuiSession = null;
          });
        });
      });
    });

    client.on('error', () => {});
    client.on('end', () => {});
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[SSH Server] Listening on ssh://0.0.0.0:${port}`);
    console.log(`[SSH Server] Connect via: ssh localhost -p ${port}`);
  });

  return server;
}
