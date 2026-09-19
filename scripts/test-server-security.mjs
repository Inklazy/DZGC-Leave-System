import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeApplication } from './backend-records.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-system-security-'));
const applicationsPath = path.join(dataDir, 'applications.json');
const contextsPath = path.join(dataDir, 'user-contexts.json');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(scriptDir, 'serve-live-copy.mjs');
const cookieA = 'security-test=account-a';
const cookieB = 'security-test=account-b';
const keyFor = (cookie) => crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 16);

function context(name, studentNo, className) {
  return { name, studentNo, className, formName: '出入申请', updatedAt: new Date().toISOString() };
}

const contextA = context('测试甲', 'SEC-A-001', '测试一班');
const contextB = context('测试乙', 'SEC-B-001', '测试二班');
fs.writeFileSync(contextsPath, JSON.stringify({
  [keyFor(cookieA)]: contextA,
  [keyFor(cookieB)]: contextB,
}, null, 2) + '\n', 'utf8');

const payload = {
  formId: '100017',
  businessNo: 'BM5017',
  subClient: 'apph5_internal_student',
  formVersion: '1',
  params: {
    gatewayTransitBeginTime: '2026-09-18 08:00:00',
    gatewayTransitEndTime: '2026-09-18 18:00:00',
    gatewayTransitReason: '事假',
    applyMove: '出校',
    gatewayTransitDesc: '安全回归测试',
  },
};
const entryA = normalizeApplication(payload, { ...contextA, clientKey: keyFor(cookieA), now: new Date('2026-09-17T10:00:00+08:00') });
const entryB = normalizeApplication({ ...payload, params: { ...payload.params, gatewayTransitDesc: '另一个账号' } }, { ...contextB, clientKey: keyFor(cookieB), now: new Date('2026-09-17T10:01:00+08:00') });
fs.writeFileSync(applicationsPath, JSON.stringify([entryA, entryB], null, 2) + '\n', 'utf8');

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

function json(response) {
  return JSON.parse(response.text);
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before becoming ready');
    try {
      const response = await request(port, '/healthz');
      if (response.status === 200) return;
    } catch {
      // Retry while the child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for test server');
}

const port = await freePort();
const childEnv = {
  ...process.env,
  LEAVE_SYSTEM_DATA_DIR: dataDir,
  LEAVE_SYSTEM_TARGET: 'http://127.0.0.1:9',
  LEAVE_SYSTEM_FORWARD_SUBMIT: '0',
  NO_PROXY: '127.0.0.1,localhost',
};
delete childEnv.LEAVE_SYSTEM_ROOT;
const child = spawn(process.execPath, [serverPath, '--host', '127.0.0.1', '--port', String(port)], {
  cwd: os.tmpdir(),
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOutput = '';
child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });

try {
  await waitForServer(port, child);

  const health = await request(port, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(json(health).service, 'leave-system');

  const anonymous = await request(port, '/api/records');
  assert.equal(anonymous.status, 401, 'anonymous local API access must be rejected');

  const ownRecords = await request(port, '/api/records', { headers: { cookie: cookieA } });
  assert.equal(ownRecords.status, 200);
  const ownIds = json(ownRecords).records.map((record) => record.submitId);
  assert.deepEqual(ownIds, [entryA.record.submitId]);

  const ownDetail = await request(port, `/api-general/ScBusinessFormSubmit/querySubmitInfo?submitId=${encodeURIComponent(entryA.record.submitId)}`, { headers: { cookie: cookieA } });
  assert.equal(ownDetail.status, 200);

  const applyList = await request(port, '/api-general/approvalCenter/getMyApply', {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json' },
    body: JSON.stringify({
      page_index: 1,
      page_size: 5,
      search: { processStatusList: ['2'], businessNoList: ['BM5017'] },
    }),
  });
  assert.equal(applyList.status, 200, 'my-apply must not force a base-data precheck or log the user out');
  assert.equal(json(applyList).localOnly, true);
  assert.equal(json(applyList).data.records[0].submitId, entryA.record.submitId);

  const crossAccountDetail = await request(port, `/api-general/ScBusinessFormSubmit/querySubmitInfo?submitId=${encodeURIComponent(entryA.record.submitId)}`, { headers: { cookie: cookieB } });
  assert.equal(crossAccountDetail.status, 404, 'a user must not read another account local detail');

  const crossAccountFlow = await request(port, `/api-general/workflow/flowRecord?processId=${encodeURIComponent(entryA.record.processId)}`, { headers: { cookie: cookieB } });
  assert.equal(crossAccountFlow.status, 404, 'a user must not read another account local flow');

  const crossAccountStatus = await request(port, `/api-general/workflow/app/status?processId=${encodeURIComponent(entryA.record.processId)}`, { headers: { cookie: cookieB } });
  assert.equal(crossAccountStatus.status, 404, 'a user must not read another account local status');

  const invalidJson = await request(port, '/api/applications', {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(invalidJson.status, 400, 'invalid JSON must return a client error');

  const tooLarge = Buffer.alloc(1024 * 1024 + 1);
  const oversized = await request(port, '/api/applications', {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json', 'content-length': String(tooLarge.length) },
    body: tooLarge,
  });
  assert.equal(oversized.status, 413, 'large request bodies must be rejected');

  const crossOriginWrite = await request(port, '/api/applications', {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify(payload),
  });
  assert.equal(crossOriginWrite.status, 403, 'cross-origin writes must be rejected');

  const submitted = await request(port, '/api-general/ScBusinessFormSubmit/submitForm', {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(submitted.status, 200);
  const submittedBody = json(submitted);
  assert.equal(submittedBody.localOnly, true);
  assert.equal(submittedBody.mode, 'local-only');
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (child.exitCode && child.exitCode !== 0) {
    console.error(childOutput);
  }
}
console.log('Server security regression tests passed.');
