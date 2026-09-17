#!/usr/bin/env node

import { spawn } from 'child_process';
import os from 'os';

const args = process.argv.slice(2);

if (args.includes('--fetch') || args.includes('-f')) {
  console.log('\x1b[32m\x1b[1mshrc.fetch v1.0.0\x1b[0m');
  console.log(`\x1b[90mOS:\x1b[0m       ${os.type()} ${os.release()} ${os.arch()}`);
  console.log(`\x1b[90mHost:\x1b[0m     ${os.hostname()}`);
  console.log(`\x1b[90mUptime:\x1b[0m   ${Math.floor(os.uptime() / 3600)} hrs, ${Math.floor((os.uptime() % 3600) / 60)} mins`);
  console.log(`\x1b[90mShell:\x1b[0m    ${process.env.SHELL || 'bash'}`);
  console.log(`\x1b[90mCPUs:\x1b[0m     ${os.cpus()[0]?.model || 'Generic CPU'} x ${os.cpus().length}`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
\x1b[32mshrc\x1b[0m — companion launcher for the irc clubhouse

Usage:
  shrc                ssh into the clubhouse
  shrc --fetch        print local system info
  shrc --help         this message

Once inside: /nick /join /op /deop /kick /ban /help
`);
  process.exit(0);
}

console.log('\x1b[32mConnecting to shrc clubhouse via SSH...\x1b[0m');

// Spawn SSH client process
const ssh = spawn('ssh', ['localhost', '-p', '2222'], {
  stdio: 'inherit'
});

ssh.on('exit', (code) => {
  process.exit(code || 0);
});
