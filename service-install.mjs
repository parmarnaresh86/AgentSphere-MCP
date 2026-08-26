/**
 * Registers chat-server.mjs as a Windows Service (SCM).
 * Run as Administrator: node service-install.mjs
 *
 * Waits for daemon exe to be written to disk before starting,
 * which prevents the "cannot find agentsphereai.exe" popup race.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __dir   = path.dirname(fileURLToPath(import.meta.url));

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error('node-windows not found. Run: npm install');
  process.exit(1);
}

const daemonDir = path.join(__dir, 'daemon');
const daemonExe = path.join(daemonDir, 'agentsphereai.exe');

const svc = new Service({
  name:             'AgentSphere AI',
  description:      'AgentSphere AI for SAP Business One - Chat Server',
  script:           path.join(__dir, 'chat-server.mjs'),
  workingDirectory: __dir,
  wait:             3,
  grow:             0.5,
  maxRetries:       5
});

// Wait for daemon exe to appear on disk (max 20s) before starting
function waitForDaemon(callback) {
  let tries = 0;
  const check = () => {
    if (fs.existsSync(daemonExe)) {
      callback();
    } else if (tries++ < 20) {
      setTimeout(check, 1000);
    } else {
      console.error('  WARN: daemon exe not found after 20s - trying to start anyway');
      callback();
    }
  };
  check();
}

svc.on('install', () => {
  console.log('  Service registered. Waiting for daemon exe...');
  waitForDaemon(() => {
    console.log('  Daemon ready. Starting service...');
    svc.start();
  });
});

svc.on('start', () => {
  console.log('  AgentSphere AI Windows Service is running.');
  console.log('  Access: http://localhost:3000');
  console.log('  Manage: services.msc');
  // Give SCM a moment to confirm running state
  setTimeout(() => process.exit(0), 2000);
});

svc.on('alreadyinstalled', () => {
  console.log('  Service already installed. Starting...');
  svc.start();
  setTimeout(() => process.exit(0), 2000);
});

svc.on('error', err => {
  console.error('  Service error:', err);
  process.exit(1);
});

// Ensure daemon dir exists before install (avoids scan error)
if (!fs.existsSync(daemonDir)) {
  fs.mkdirSync(daemonDir, { recursive: true });
}

console.log('  Installing AgentSphere AI as a Windows Service...');
svc.install();
