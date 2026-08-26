/**
 * Removes the AgentSphere AI Windows Service.
 * Run as Administrator: node service-uninstall.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dir   = path.dirname(fileURLToPath(import.meta.url));
const { Service } = require('node-windows');

const svc = new Service({
  name:   'AgentSphere AI',
  script: path.join(__dir, 'chat-server.mjs')
});

svc.on('stop',      () => { console.log('  Service stopped.'); svc.uninstall(); });
svc.on('uninstall', () => console.log('  AgentSphere AI Windows Service removed.'));
svc.on('error',     err => { console.error('  Error:', err); process.exit(1); });

console.log('  Removing AgentSphere AI Windows Service...');
if (svc.exists) {
  svc.stop();
} else {
  console.log('  Service not found - nothing to remove.');
}
