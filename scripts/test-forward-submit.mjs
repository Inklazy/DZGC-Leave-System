import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(scriptDir, 'serve-live-copy.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-system-forward-'));
const cookie = 'forward-test=account';
const clientKey = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 16);
fs.writeFileSync(path.join(dataDir, 'user-contexts.json'), JSON.stringify({
  [clientKey]: {
    name: '转发测试',
    studentNo: 'FORWARD-001',
    className: '转发测试班',
    formName: '出入申请',
    updatedAt: new Date().toISOString(),
  },
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(dataDir, 'applications.json'), '[]\n', 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('forward test server exited early');
    try {
      if ((await request(port, '/healthz')).status === 200) return;
    } catch {
      // Retry while the child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for forward test server');
}

const targetPort = await freePort();
let targetBody = '';
let targetTransferEncoding = '';
const target = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    targetBody = Buffer.concat(chunks).toString('utf8');
    targetTransferEncoding = req.headers['transfer-encoding'] || '';
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'session=abc; Path=/; Domain=127.0.0.1; Secure; SameSite=None; Partitioned',
    });
    res.end(JSON.stringify({ code: 0, msg: 'origin-ok' }));
  });
});
await new Promise((resolve, reject) => {
  target.once('error', reject);
  target.listen(targetPort, '127.0.0.1', resolve);
});

const port = await freePort();
const childEnv = {
  ...process.env,
  LEAVE_SYSTEM_DATA_DIR: dataDir,
  LEAVE_SYSTEM_TARGET: 'http://127.0.0.1:' + targetPort,
  LEAVE_SYSTEM_FORWARD_SUBMIT: '1',
  HTTP_PROXY: 'http://127.0.0.1:1',
  NO_PROXY: '127.0.0.1,localhost',
};
delete childEnv.LEAVE_SYSTEM_ROOT;
const child = spawn(process.execPath, [serverPath, '--host', '127.0.0.1', '--port', String(port)], {
  cwd: os.tmpdir(),
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await waitForServer(port, child);
  const payload = {
    formId: '100017',
    params: {
      gatewayTransitBeginTime: '2026-09-18 08:00:00',
      gatewayTransitEndTime: '2026-09-18 18:00:00',
      gatewayTransitDesc: '转发回归测试',
    },
  };
  const response = await request(port, '/api-general/ScBusinessFormSubmit/submitForm', {
    method: 'POST',
    headers: {
      cookie,
      origin: 'http://127.0.0.1:' + port,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).msg, 'origin-ok');
  assert.match(response.headers['set-cookie'][0], /SameSite=Lax/u);
  assert.doesNotMatch(response.headers['set-cookie'][0], /(?:Secure|Domain|Partitioned)/u);
  assert.equal(targetBody, JSON.stringify(payload));
  assert.equal(targetTransferEncoding, '', 'proxy must not forward the client transfer-encoding header');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'applications.json'), 'utf8')), []);
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await new Promise((resolve) => target.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('Forward submit regression tests passed.');
