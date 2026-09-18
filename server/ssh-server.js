import ssh2 from 'ssh2';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TUISession } from './tui-engine.js';

const { Server, utils } = ssh2;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const HOST_KEY_PATH = path.join(DATA_DIR, 'host_key');

function generateHostKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  return privateKey;
}

function keyUsable(pem) {
  try {
    const parsed = utils.parseKey(pem);
    return parsed && !(parsed instanceof Error);
  } catch {
    return false;
  }
}

function getHostKey() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  let pem = fs.existsSync(HOST_KEY_PATH)
    ? fs.readFileSync(HOST_KEY_PATH, 'utf-8')
    : '';

  if (!keyUsable(pem)) {
    console.log('[SSH Server] Generating new SSH host key (RSA 2048)...');
    pem = generateHostKey();
    fs.writeFileSync(HOST_KEY_PATH, pem, 'utf-8');
  }

  return pem;
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

    let noneTries = 0;

    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey' && ctx.key && ctx.key.data) {
        const fp = computeFingerprint(ctx.key.data);
        authenticatedUser = {
          username: suggestedNick(ctx.username),
          fingerprint: fp,
          ip
        };
        return ctx.accept();
      }

      if (ctx.method === 'none') {
        noneTries++;
        if (noneTries === 1 && !authenticatedUser) {
          return ctx.reject(['publickey', 'none']);
        }
        if (!authenticatedUser) {
          authenticatedUser = {
            username: suggestedNick(ctx.username),
            fingerprint: 'anon:' + crypto.randomBytes(3).toString('hex'),
            ip
          };
        }
        return ctx.accept();
      }

      return ctx.reject(['publickey', 'none']);
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
