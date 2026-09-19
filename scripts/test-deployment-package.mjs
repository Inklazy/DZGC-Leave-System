import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.LEAVE_SYSTEM_ROOT || path.join(scriptDir, '..'));
const packagePath = path.join(root, 'package.json');
const projectRootPath = path.join(root, 'scripts', 'project-root.mjs');
const serverPath = path.join(root, 'scripts', 'serve-live-copy.mjs');
const liveVerifyPath = path.join(root, 'scripts', 'verify-live-copy.mjs');
const obsoleteServerlessDir = path.join(root, 'worker');
const obsoleteCliName = ['wrang', 'ler'].join('');
const obsoleteCliConfigPath = path.join(root, `${obsoleteCliName}.jsonc`);
const obsoleteServerlessTestName = ['test', 'worker', 'backend.mjs'].join('-');
const obsoleteServerlessTestPath = path.join(root, 'scripts', obsoleteServerlessTestName);
const deployDocPath = path.join(root, 'DEPLOY.md');
const dockerfilePath = path.join(root, 'Dockerfile');
const dockerignorePath = path.join(root, '.dockerignore');
const composePath = path.join(root, 'compose.yaml');
const vpsBuildComposePath = path.join(root, 'compose.vps-build.yaml');
const workflowPath = path.join(root, '.github', 'workflows', 'docker.yml');

assert.ok(fs.existsSync(packagePath), 'package.json is required for server deployment');
assert.ok(fs.existsSync(projectRootPath), 'scripts/project-root.mjs is required for portable project root resolution');
assert.ok(fs.existsSync(deployDocPath), 'DEPLOY.md is required for beginner deployment steps');
assert.ok(fs.existsSync(dockerfilePath), 'Dockerfile is required for container deployment');
assert.ok(fs.existsSync(dockerignorePath), '.dockerignore is required for container deployment');
assert.ok(fs.existsSync(composePath), 'compose.yaml is required for container deployment');
assert.ok(fs.existsSync(vpsBuildComposePath), 'compose.vps-build.yaml is required for VPS-local image builds');
assert.ok(fs.existsSync(workflowPath), 'GitHub Actions Docker workflow is required');
assert.ok(!fs.existsSync(obsoleteCliConfigPath), 'obsolete serverless CLI config should not be included in the server-only deployment package');
assert.ok(!fs.existsSync(obsoleteServerlessTestPath), 'obsolete serverless backend test should not be included in the server-only deployment package');

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
assert.equal(pkg.type, 'module');
assert.equal(pkg.scripts.start, 'node scripts/serve-live-copy.mjs');
assert.ok(pkg.scripts.test.includes('test-local-backend.mjs'));
assert.ok(pkg.scripts.test.includes('test-server-security.mjs'));
assert.ok(pkg.scripts.test.includes('test-forward-submit.mjs'));
assert.ok(!pkg.scripts.test.includes(obsoleteServerlessTestName));
assert.ok(pkg.scripts.verify.includes('verify-live-copy.mjs'));
assert.ok(!JSON.stringify(pkg).toLowerCase().includes(obsoleteCliName), 'package.json should not depend on serverless deployment tooling');

const projectRootSource = fs.readFileSync(projectRootPath, 'utf8');
assert.ok(projectRootSource.includes('process.env.LEAVE_SYSTEM_ROOT ||'), 'project-root.mjs must honor LEAVE_SYSTEM_ROOT');
assert.ok(projectRootSource.includes('fileURLToPath(import.meta.url)'), 'project-root.mjs must fall back to its own location');

for (const filePath of [serverPath, liveVerifyPath]) {
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(source.includes("from './project-root.mjs'"), `${path.basename(filePath)} must import portable project root resolution`);
  assert.ok(!source.includes("path.resolve('E:/dev/Copy Leave System')"), `${path.basename(filePath)} must not hardcode a Windows path`);
}

const serverSource = fs.readFileSync(serverPath, 'utf8');
assert.ok(serverSource.includes("process.env.HOST || '0.0.0.0'"), 'server must default to the Docker-compatible host');
assert.ok(serverSource.includes('server.listen(port, host'), 'server must listen using the configured host');
for (const required of ['MAX_BODY_BYTES', 'MAX_RESPONSE_BYTES', 'isSafeWriteRequest', "/healthz", 'x-content-type-options', 'LEAVE_SYSTEM_DATA_DIR', 'transfer-encoding']) {
  assert.ok(serverSource.includes(required), 'server is missing hardening marker: ' + required);
}

const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
for (const required of [
  'node:24-bookworm-slim',
  'WORKDIR /app',
  'scripts/serve-live-copy.mjs ./scripts/serve-live-copy.mjs',
  'scripts/backend-records.mjs ./scripts/backend-records.mjs',
  'scripts/project-root.mjs ./scripts/project-root.mjs',
  'leave-system-live-copy ./leave-system-live-copy',
  'EXPOSE 8123',
  '/healthz',
  'CMD ["node", "scripts/serve-live-copy.mjs"]',
]) {
  assert.ok(dockerfile.includes(required), `Dockerfile missing: ${required}`);
}
assert.ok(!dockerfile.includes('COPY data'), 'Dockerfile must not copy runtime data');

const dockerignore = fs.readFileSync(dockerignorePath, 'utf8');
for (const required of ['data', 'node_modules', '.git', '.env']) {
  assert.ok(dockerignore.split(/\r?\n/u).includes(required), `.dockerignore missing: ${required}`);
}

const compose = fs.readFileSync(composePath, 'utf8');
for (const required of [
  'name: leave-system',
  'ghcr.io/zekty/dzgc-leave-system:latest',
  '127.0.0.1:8123:8123',
  '/opt/leave-system-data:/app/data',
  'LEAVE_SYSTEM_DATA_DIR: /app/data',
  'LEAVE_SYSTEM_FORWARD_SUBMIT',
  'restart: unless-stopped',
]) {
  assert.ok(compose.includes(required), `compose.yaml missing: ${required}`);
}

const vpsBuildCompose = fs.readFileSync(vpsBuildComposePath, 'utf8');
for (const required of [
  'image: dzgc-leave-system:local',
  'build:',
  'context: .',
  'dockerfile: Dockerfile',
]) {
  assert.ok(vpsBuildCompose.includes(required), `compose.vps-build.yaml missing: ${required}`);
}

const workflow = fs.readFileSync(workflowPath, 'utf8');
for (const required of [
  'packages: write',
  'docker/login-action@v3',
  'docker/metadata-action@v5',
  'docker/build-push-action@v6',
  'REGISTRY: ghcr.io',
  'IMAGE_NAME: zekty/dzgc-leave-system',
]) {
  assert.ok(workflow.includes(required), `.github/workflows/docker.yml missing: ${required}`);
}

const deployDoc = fs.readFileSync(deployDocPath, 'utf8');
for (const required of [
  'Debian 13',
  'Caddy',
  'Docker',
  'GHCR',
  'docker compose pull',
  'compose.vps-build.yaml',
  'docker compose -f compose.yaml -f compose.vps-build.yaml build --pull',
  'git archive --format=tar.gz',
  '/opt/leave-system-data',
  '/healthz',
  'LEAVE_SYSTEM_FORWARD_SUBMIT',
  'ghcr.io/zekty/dzgc-leave-system:latest',
]) {
  assert.ok(deployDoc.includes(required), `DEPLOY.md missing: ${required}`);
}

for (const forbidden of [
  ['Cloud', 'flare'].join(''),
  ['Work', 'er'].join(''),
  ['Wrang', 'ler'].join(''),
  obsoleteCliName,
  ['LEAVE', 'RECORDS'].join('_'),
  ['K', 'V'].join(''),
  ['workers', 'dev'].join('.'),
]) {
  assert.ok(!deployDoc.includes(forbidden), `DEPLOY.md still mentions removed server target: ${forbidden}`);
}

if (fs.existsSync(obsoleteServerlessDir)) {
  const obsoleteFiles = fs.readdirSync(obsoleteServerlessDir);
  assert.equal(obsoleteFiles.length, 0, 'obsolete serverless source directory should be empty or removed in server-only mode');
}

console.log('Server deployment package tests passed.');
