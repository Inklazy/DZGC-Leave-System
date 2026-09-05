import fs from 'node:fs';
import path from 'node:path';
import { hasExtensionArtifacts } from './html-artifacts.mjs';
import { root } from './project-root.mjs';

const sourceDir = path.join(root, 'myhtml');
const liveDir = path.join(root, 'leave-system-live-copy');

const requiredScripts = [
  'generate-live-copy.mjs',
  'serve-live-copy.mjs',
  'verify-live-copy.mjs',
  'backend-records.mjs',
  'test-local-backend.mjs',
  'test-live-api-utf8.mjs',
];

const aliasFiles = ['index.html', 'home.html', 'out.html', 'apply.html', 'records.html'];
const sourcePages = [
  '步骤1登录.html',
  '步骤2进入首页.html',
  '步骤3点击进出申请进去外出申请.html',
  '步骤4点击外出申请进入申请页.html',
  '步骤3-5进入我的申请查看申请记录等.html',
];

const failures = [];

function fail(message) {
  failures.push(message);
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function activeScripts(html) {
  return [...html.matchAll(/<script\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => !/application\/x-copy-disabled/i.test(tag));
}

function assertNoExtensionArtifacts(dir, label) {
  if (!exists(dir)) {
    return;
  }

  for (const filePath of walk(dir).filter((file) => file.endsWith('.html'))) {
    const html = read(filePath);
    if (hasExtensionArtifacts(html)) {
      const relative = path.relative(dir, filePath).replaceAll(path.sep, '/');
      fail(`Immersive Translate artifact remains in ${label}: ${relative}`);
    }
  }
}

if (!exists(sourceDir)) {
  fail(`Missing source directory: ${sourceDir}`);
}

for (const scriptName of requiredScripts) {
  const scriptPath = path.join(root, 'scripts', scriptName);
  if (!exists(scriptPath)) {
    fail(`Missing live script: scripts/${scriptName}`);
  }
}

if (!exists(liveDir)) {
  fail(`Missing generated live copy directory: ${liveDir}`);
}

assertNoExtensionArtifacts(sourceDir, 'source page');
assertNoExtensionArtifacts(liveDir, 'live page');

if (exists(liveDir)) {
  const guardPath = path.join(liveDir, 'live-guard.js');
  if (!exists(guardPath)) {
    fail('Missing live config guard: live-guard.js');
  } else {
    const guard = read(guardPath);
    if (!guard.includes('local-json-active')) {
      fail('Live guard missing local JSON backend status');
    }
    if (!guard.includes('/api-general/ScBusinessFormSubmit/submitForm')) {
      fail('Live guard missing submit endpoint marker');
    }
    if (!guard.includes('/api-general/approvalCenter/getMyApply')) {
      fail('Live guard missing records endpoint marker');
    }
    if (guard.includes('stopImmediatePropagation')) {
      fail('Live guard must not block original submit handlers');
    }
    if (guard.includes('disabledMessage')) {
      fail('Live guard still contains disabled-backend submit message');
    }
  }

  for (const alias of aliasFiles) {
    const aliasPath = path.join(liveDir, alias);
    if (!exists(aliasPath)) {
      fail(`Missing live alias page: ${alias}`);
      continue;
    }

    const html = read(aliasPath);
    if (!html.includes('./live-guard.js')) {
      fail(`Live guard not injected in alias page: ${alias}`);
    }
    if (html.includes('copy-navigation.js')) {
      fail(`Static navigation helper leaked into live page: ${alias}`);
    }
    if (html.includes('application/x-copy-disabled')) {
      fail(`Original runtime is disabled in live page: ${alias}`);
    }
    if (!activeScripts(html).some((tag) => /index-ebfab978\.js/i.test(tag))) {
      fail(`Original Vue runtime entry script missing in live page: ${alias}`);
    }
  }

  for (const sourcePage of sourcePages) {
    if (!exists(path.join(liveDir, sourcePage))) {
      fail(`Missing copied live source page: ${sourcePage}`);
    }
  }

  const files = walk(liveDir).map((file) => path.relative(liveDir, file).replaceAll(path.sep, '/'));
  if (!files.some((file) => file.endsWith('index-ebfab978.js.下载'))) {
    fail('Live copy missing saved original runtime bundle');
  }
}

const serverPath = path.join(root, 'scripts', 'serve-live-copy.mjs');
if (exists(serverPath)) {
  const server = read(serverPath);
  for (const expected of [
    'http://esp.qmxy.com',
    'leave-system-live-copy',
    '/api/records',
    '/api/applications',
    '/api-general/ScBusinessFormSubmit/submitForm',
    '/api-general/approvalCenter/getMyApply',
    'local-json-active',
    'applications.json',
  ]) {
    if (!server.includes(expected)) {
      fail(`Live server missing expected behavior marker: ${expected}`);
    }
  }
}

if (failures.length) {
  console.error(`Live verification failed (${failures.length}):`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Live verification passed: generated proxy-backed copy is complete.');
