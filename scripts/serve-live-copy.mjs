import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { root } from './project-root.mjs';
import {
  buildLocalFlowRecord,
  buildLocalSubmitInfo,
  buildLocalWorkflowStatus,
  createLocalOnlyApplyResponse,
  deriveUserContextFromOriginRecords,
  deriveWorkflowTemplateFromOriginFlow,
  findApplicationByLocalId,
  hydrateApplicationRecord,
  loadApplications,
  mergeRecords,
  originQueryForMergedPage,
  recordsFromApplications,
  saveApplication,
  selectApplicationsForUser,
} from './backend-records.mjs';

const liveDir = path.join(root, 'leave-system-live-copy');
const dataDir = path.resolve(process.env.LEAVE_SYSTEM_DATA_DIR || path.join(root, 'data'));
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const forwardSubmit = process.env.LEAVE_SYSTEM_FORWARD_SUBMIT === '1';

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

const applicationsPath = path.join(dataDir, 'applications.json');
const userContextsPath = path.join(dataDir, 'user-contexts.json');
const defaultTarget = 'http://esp.qmxy.com';
const submitEndpoint = '/api-general/ScBusinessFormSubmit/submitForm';
const myApplyEndpoint = '/api-general/approvalCenter/getMyApply';
const baseDataEndpoint = '/api-general/account/getIndexDataComm';
const submitInfoEndpoint = '/api-general/ScBusinessFormSubmit/querySubmitInfo';
const flowRecordEndpoint = '/api-general/workflow/flowRecord';
const workflowStatusEndpoint = '/api-general/workflow/app/status';
const detailBundleVersion = '20260611-local-detail';
const liveAppShellPaths = new Set(['/', '/index.html', '/home.html', '/out.html', '/apply.html', '/records.html']);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const port = Number(argValue('--port', process.env.PORT || '8123'));
const host = argValue('--host', process.env.HOST || '0.0.0.0');
const targetOrigin = argValue('--target', process.env.LEAVE_SYSTEM_TARGET || defaultTarget).replace(/\/$/u, '');
const targetUrl = new URL(targetOrigin);
if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password || targetUrl.pathname !== '/' || targetUrl.search || targetUrl.hash) {
  throw new Error('LEAVE_SYSTEM_TARGET must be an HTTP(S) origin without credentials or path');
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('Invalid port');
}

function contentType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.mjs') || lower.endsWith('.js') || lower.endsWith('.js.下载')) return 'application/javascript; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.ttf')) return 'font/ttf';
  if (lower.endsWith('.map')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function detailPageData(data) {
  return {
    ...data,
    data,
  };
}

function redirect(res, location) {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
  });
  res.end();
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw httpError(413, 'Request body exceeds 1 MiB');
  }
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(body) {
  if (!body || !body.length) {
    return {};
  }

  const text = body.toString('utf8').trim();
  if (!text) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, 'JSON body must be an object');
  }

  const pending = [[parsed, 0]];
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (depth > 32) throw httpError(400, 'JSON nesting is too deep');
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') pending.push([child, depth + 1]);
    }
  }
  return parsed;
}

function safeLocalPath(urlPathname) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }

  if (pathname === '/') {
    pathname = '/index.html';
  }

  const candidate = path.resolve(liveDir, `.${pathname}`);
  return candidate === liveDir || candidate.startsWith(`${liveDir}${path.sep}`) ? candidate : null;
}

function isTextualContentType(type) {
  return /(?:text\/|javascript|json|xml|css|html)/i.test(type || '');
}

function normalizeSavedScriptUrls(text) {
  return text.replace(/\.js\.\u4e0b\u8f7d(?=(?:["'<\s?#]|$))/gu, '.js');
}

function rewriteTextForLocalOrigin(text, req) {
  const localOrigin = `http://${req.headers.host || `127.0.0.1:${port}`}`;
  const rewritten = normalizeSavedScriptUrls(text)
    .replace(/(pages-tool-approvalDetailPage-approvalDetailPage\.[\w-]+\.js)(?!\?local-detail-v=)/gu, `$1?local-detail-v=${detailBundleVersion}`)
    .replaceAll('http://esp.qmxy.com', localOrigin)
    .replaceAll('https://esp.qmxy.com', localOrigin);
  const reqUrl = new URL(req.url || '/', localOrigin);
  if (/pages-tool-approvalDetailPage-approvalDetailPage\.[\w-]+\.js$/u.test(reqUrl.pathname)) {
    return patchApprovalDetailPageScript(rewritten);
  }
  return rewritten;
}

function patchApprovalDetailPageScript(text) {
  const marker = 'f((e=>{G=e.submitId,J=e.processId,K.value=e.taskId,Q=e.isCanApproval,X=e.isCanCancel}))';
  const loadMarker = 'async function Z(){var e,a;P.value=!0';
  let patched = text;

  if (patched.includes(marker)) {
    const replacement = `f((e=>{e=e&&Object.keys(e).length?e:Object.fromEntries(new URLSearchParams((location.hash.split("?")[1]||"")));G=e.submitId,J=e.processId,K.value=e.taskId,Q=e.isCanApproval,X=e.isCanCancel,P.value&&Z()}))`;
    patched = patched.replace(marker, replacement);
  }

  if (patched.includes(loadMarker)) {
    const replacement = `async function Z(){var e,a;if(!G){const __localDetailQuery=Object.fromEntries(new URLSearchParams((location.hash.split("?")[1]||"")));G=__localDetailQuery.submitId,J=__localDetailQuery.processId,K.value=__localDetailQuery.taskId,Q=__localDetailQuery.isCanApproval,X=__localDetailQuery.isCanCancel}P.value=!0`;
    patched = patched.replace(loadMarker, replacement);
  }

  return patched;
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

function clientKeyFromRequest(req) {
  const cookie = headerValue(req.headers, 'cookie') || '';
  const authorization = headerValue(req.headers, 'authorization') || '';
  const source = `${cookie}\n${authorization}`.trim();
  if (!source) {
    return 'default';
  }

  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function loadJsonObject(storagePath) {
  if (!fs.existsSync(storagePath)) {
    return {};
  }

  const raw = fs.readFileSync(storagePath, 'utf8').trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function saveJsonObject(storagePath, data) {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  const tempPath = `${storagePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, storagePath);
}

function cleanContext(context = {}) {
  if (!context || typeof context !== 'object') return {};
  const cleaned = {};
  for (const key of ['name', 'userName', 'studentNo', 'userNo', 'collegeName', 'majorName', 'className', 'clazzName', 'departmentName', 'formName']) {
    const value = context[key];
    if (typeof value === 'string' && value.trim() && value.trim() !== '--') {
      cleaned[key] = value.trim();
    }
  }
  return cleaned;
}

function workflowTemplateFromContext(context = {}) {
  if (!context || typeof context !== 'object') return null;
  const template = deriveWorkflowTemplateFromOriginFlow(context.workflowTemplate);
  return template?.actList?.length ? template : null;
}

function accountKeyFromContext(context = {}) {
  if (!context || typeof context !== 'object') return '';
  return String(context.userNo || context.studentNo || '').trim();
}

function workflowTemplateForAccount(context, contexts) {
  const accountKey = accountKeyFromContext(context);
  if (!accountKey) {
    return null;
  }

  const candidates = Object.values(contexts)
    .filter((candidate) => accountKeyFromContext(candidate) === accountKey)
    .sort((left, right) => Date.parse(right?.updatedAt || '') - Date.parse(left?.updatedAt || ''));

  for (const candidate of candidates) {
    const template = workflowTemplateFromContext(candidate);
    if (template) {
      return template;
    }
  }

  return null;
}

function mergeUserContexts(...contexts) {
  const merged = {};
  for (const context of contexts) {
    const cleaned = cleanContext(context);
    for (const [key, value] of Object.entries(cleaned)) {
      if (!merged[key]) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function userContextFromBaseData(envelope = {}) {
  const data = envelope?.data || envelope;
  const userInfo = data?.userInfo || {};
  const orgaInfo = data?.orgaInfo || {};
  return mergeUserContexts({
    name: userInfo.name || userInfo.userName || userInfo.realName,
    userName: userInfo.userName,
    studentNo: userInfo.userNo || userInfo.studentNo || userInfo.account || userInfo.accountNo,
    userNo: userInfo.userNo,
    collegeName: userInfo.collegeName || userInfo.schoolName || orgaInfo.collegeName || orgaInfo.schoolName,
    majorName: userInfo.majorName || userInfo.professionName || userInfo.specialtyName || orgaInfo.majorName || orgaInfo.professionName,
    className: userInfo.className || userInfo.clazzName || userInfo.deptName || orgaInfo.orgaName || orgaInfo.deptName,
    departmentName: userInfo.departmentName || userInfo.orgName || orgaInfo.orgaName,
  });
}

function contextHasIdentity(context = {}) {
  if (!context || typeof context !== 'object') return false;
  return Boolean(
    (context.name || context.userName) &&
    (context.studentNo || context.userNo) &&
    (context.className || context.clazzName || context.departmentName),
  );
}

function payloadHasIdentity(payload = {}) {
  const params = payload.params && typeof payload.params === 'object' ? payload.params : payload;
  return Boolean(
    (params.name || params.userName || params.realName) &&
    (params.userNo || params.studentNo || params.studentNumber) &&
    (params.className || params.clazzName || params.departmentName),
  );
}

function contextForClient(clientKey) {
  return loadJsonObject(userContextsPath)[clientKey] || {};
}

function allUserContexts() {
  return loadJsonObject(userContextsPath);
}

function saveContextForClient(clientKey, context) {
  const cleaned = cleanContext(context);
  if (!clientKey || clientKey === 'default') return cleaned;
  const contexts = loadJsonObject(userContextsPath);
  const existing = contexts[clientKey] || {};
  const suppliedTemplate = workflowTemplateFromContext(context);
  const savedTemplate = workflowTemplateFromContext(existing);
  const accountTemplate = workflowTemplateForAccount({ ...existing, ...cleaned }, contexts);
  const workflowTemplate = suppliedTemplate || savedTemplate || accountTemplate;
  if (!Object.keys(cleaned).length && !workflowTemplate) {
    return existing;
  }

  const merged = {
    ...mergeUserContexts(cleaned, existing),
    updatedAt: new Date().toISOString(),
  };
  if (workflowTemplate) {
    merged.workflowTemplate = workflowTemplate;
  }
  contexts[clientKey] = merged;
  saveJsonObject(userContextsPath, contexts);
  return merged;
}

async function ensureUserContext(req) {
  if (req.verifiedContext) return req.verifiedContext;

  const clientKey = clientKeyFromRequest(req);
  if (clientKey === 'default') throw httpError(401, 'Authentication required');

  const existing = contextForClient(clientKey);
  // The key contains the login credential; reuse its saved identity for local-only requests.
  if (contextHasIdentity(existing)) {
    req.verifiedContext = existing;
    return existing;
  }

  const remoteResponse = await fetchTarget(req, new URL(baseDataEndpoint, targetOrigin), null, undefined, 'GET');
  if (remoteResponse.status === 401 || remoteResponse.status === 403) throw httpError(401, 'Session expired');
  if (remoteResponse.status !== 200) throw httpError(502, 'Unable to verify session');

  let envelope;
  try {
    envelope = JSON.parse(remoteResponse.body.toString('utf8'));
  } catch {
    throw httpError(502, 'Invalid authentication response');
  }

  const context = userContextFromBaseData(envelope);
  if (!accountKeyFromContext(context) || (envelope.code !== undefined && ![0, 200, '0', '200'].includes(envelope.code))) {
    throw httpError(401, 'Session expired');
  }

  req.verifiedContext = saveContextForClient(clientKey, context);
  return req.verifiedContext;
}

function localApplicationsForClient(req, userContext = {}) {
  const clientKey = clientKeyFromRequest(req);
  const context = mergeUserContexts(userContext, contextForClient(clientKey));
  return selectApplicationsForUser(loadApplications(applicationsPath), {
    ...context,
    clientKey,
  }, allUserContexts());
}

function currentLocalRecords(req, userContext = {}) {
  const context = mergeUserContexts(userContext, contextForClient(clientKeyFromRequest(req)));
  return recordsFromApplications(localApplicationsForClient(req), context);
}

async function findLocalApplicationWithContext(req, localId) {
  const context = await ensureUserContext(req);
  return findApplicationByLocalId(localApplicationsForClient(req, context), localId, context);
}

function responseHeaders(remoteResponse, bodyLength, textual) {
  const headers = {};
  for (const [key, value] of Object.entries(remoteResponse.headers)) {
    const lower = key.toLowerCase();
    if ([
      'content-length',
      'transfer-encoding',
      'content-encoding',
      'connection',
      'keep-alive',
      'strict-transport-security',
    ].includes(lower)) {
      continue;
    }
    if (lower === 'set-cookie') {
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  const rawSetCookie = remoteResponse.headers['set-cookie'];
  const setCookies = Array.isArray(rawSetCookie) ? rawSetCookie : rawSetCookie ? [rawSetCookie] : [];
  if (setCookies.length) {
    headers['set-cookie'] = setCookies.map((cookie) => cookie
      .replace(/;\s*Domain=[^;]+/ig, '')
      .replace(/;\s*Secure/ig, '')
      .replace(/;\s*SameSite=None/ig, '; SameSite=Lax')
      .replace(/;\s*Partitioned/ig, ''));
  }

  if (textual && !headers['content-type']) {
    headers['content-type'] = 'text/plain; charset=utf-8';
  }
  headers['content-length'] = String(bodyLength);
  headers['cache-control'] = 'no-store';
  return headers;
}

function proxyIsBypassed(remoteUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!noProxy.trim()) return false;
  const hostname = remoteUrl.hostname.toLowerCase();
  const port = remoteUrl.port || (remoteUrl.protocol === 'https:' ? '443' : '80');
  return noProxy.split(',').some((rawRule) => {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return true;
    const [rawRuleHost, rulePort] = rule.split(':');
    const ruleHost = rawRuleHost.replace(/^\./u, '');
    const hostMatches = hostname === ruleHost || hostname.endsWith('.' + ruleHost);
    return hostMatches && (!rulePort || rulePort === port);
  });
}

function requestViaNode(remoteUrl, { method, headers, body }) {
  const proxyEnv = remoteUrl.protocol === 'https:'
    ? process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    : process.env.HTTP_PROXY;
  const proxyUrl = proxyEnv && !proxyIsBypassed(remoteUrl) ? new URL(proxyEnv) : null;

  return new Promise((resolve, reject) => {
    const useProxy = proxyUrl && remoteUrl.protocol === 'http:';
    const requestUrl = useProxy ? proxyUrl : remoteUrl;
    const transport = requestUrl.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers };
    requestHeaders.host = remoteUrl.host;

    const req = transport.request({
      hostname: requestUrl.hostname,
      port: requestUrl.port || (requestUrl.protocol === 'https:' ? 443 : 80),
      method,
      path: useProxy ? remoteUrl.href : `${remoteUrl.pathname}${remoteUrl.search}`,
      headers: requestHeaders,
      timeout: 30000,
    }, (remoteRes) => {
      const chunks = [];
      let size = 0;
      remoteRes.on('error', reject);
      remoteRes.on('aborted', () => reject(new Error('Upstream response aborted')));
      remoteRes.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          remoteRes.destroy(new Error('Upstream response exceeds limit'));
          return;
        }
        chunks.push(chunk);
      });
      remoteRes.on('end', () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: remoteRes.headers,
          status: remoteRes.statusCode || 502,
        });
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Timed out fetching ${remoteUrl.href}`)));
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function serveLocalFile(req, res, filePath) {
  const data = fs.readFileSync(filePath);
  const type = contentType(filePath);
  if (isTextualContentType(type)) {
    const rewritten = rewriteTextForLocalOrigin(data.toString('utf8'), req);
    const bytes = Buffer.from(rewritten, 'utf8');
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    });
    res.end(bytes);
    return;
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': String(data.length),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function savedScriptVariant(localPath) {
  if (!localPath || fs.existsSync(localPath) || path.extname(localPath).toLowerCase() !== '.js') {
    return null;
  }

  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return null;
  }

  const basename = path.basename(localPath);
  const match = fs.readdirSync(dir).find((name) => name.startsWith(`${basename}.`));
  return match ? path.join(dir, match) : null;
}

function remoteUrlFor(reqUrl, localPath) {
  const basename = localPath ? path.basename(localPath).replace(/\.下载$/u, '') : '';
  const isMissingSavedAsset = localPath && /_files$/u.test(path.basename(path.dirname(localPath)));
  if (isMissingSavedAsset && basename) {
    return new URL(`/assets/${basename}${reqUrl.search}`, targetOrigin);
  }

  if (reqUrl.pathname.startsWith('/assets/')) {
    return new URL(`${reqUrl.pathname}${reqUrl.search}`, targetOrigin);
  }

  return new URL(`${reqUrl.pathname}${reqUrl.search}`, targetOrigin);
}

function targetRequestHeaders(req, body) {
  const headers = {};

  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const lower = name.toLowerCase();
    if ([
      'host',
      'connection',
      'content-length',
      'transfer-encoding',
      'accept-encoding',
      'proxy-connection',
      'te',
      'upgrade',
    ].includes(lower)) {
      continue;
    }
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers.host = targetUrl.host;
  headers.origin = targetOrigin;
  headers.referer = targetOrigin + '/';
  if (body) {
    headers['content-length'] = String(body.length);
  }

  return headers;
}

async function fetchTarget(req, reqUrl, localPath, bodyOverride, methodOverride) {
  const remoteUrl = remoteUrlFor(reqUrl, localPath);
  const method = methodOverride || req.method || 'GET';
  const body = bodyOverride ?? (['GET', 'HEAD'].includes(method) ? undefined : await readRequestBody(req));
  const headers = targetRequestHeaders(req, body);

  return requestViaNode(remoteUrl, {
    method,
    headers,
    body,
  });
}

async function proxyToTarget(req, res, reqUrl, localPath, bodyOverride) {
  const remoteUrl = remoteUrlFor(reqUrl, localPath);
  const remoteResponse = await fetchTarget(req, reqUrl, localPath, bodyOverride);

  const remoteType = headerValue(remoteResponse.headers, 'content-type') || contentType(remoteUrl.pathname);
  const textual = isTextualContentType(remoteType);

  if (textual) {
    const rewritten = rewriteTextForLocalOrigin(remoteResponse.body.toString('utf8'), req);
    const bytes = Buffer.from(rewritten, 'utf8');
    res.writeHead(remoteResponse.status, responseHeaders(remoteResponse, bytes.length, true));
    res.end(bytes);
    return;
  }

  const bytes = remoteResponse.body;
  res.writeHead(remoteResponse.status, responseHeaders(remoteResponse, bytes.length, false));
  res.end(bytes);
}

function injectLiveGuard(text) {
  const script = '<script src="/live-guard.js"></script>';
  if (text.includes(script)) {
    return text;
  }

  return text.includes('</body>')
    ? text.replace('</body>', `${script}</body>`)
    : `${text}${script}`;
}

async function serveCurrentOriginAppShell(req, res) {
  const localOrigin = `http://${req.headers.host || `127.0.0.1:${port}`}`;
  const shellUrl = new URL('/', localOrigin);
  const remoteResponse = await fetchTarget(req, shellUrl, null);
  const remoteType = headerValue(remoteResponse.headers, 'content-type') || 'text/html; charset=utf-8';

  if (!isTextualContentType(remoteType)) {
    const bytes = remoteResponse.body;
    res.writeHead(remoteResponse.status, responseHeaders(remoteResponse, bytes.length, false));
    res.end(bytes);
    return;
  }

  const rewritten = injectLiveGuard(rewriteTextForLocalOrigin(remoteResponse.body.toString('utf8'), req));
  const bytes = Buffer.from(rewritten, 'utf8');
  res.writeHead(remoteResponse.status, responseHeaders(remoteResponse, bytes.length, true));
  res.end(bytes);
}

function originRecordsFromEnvelope(envelope = {}) {
  const data = envelope?.data && typeof envelope.data === 'object' ? envelope.data : envelope;
  return Array.isArray(data?.records) ? data.records : [];
}

function latestOriginProcessId(envelope = {}) {
  const record = originRecordsFromEnvelope(envelope).find((item) => {
    const processId = String(item?.processId || '').trim();
    return processId &&
      !processId.startsWith('local-') &&
      String(item?.processStatus ?? '') === '2';
  });
  return record?.processId || '';
}

function saveWorkflowTemplateForClient(req, originFlowEnvelope) {
  const template = deriveWorkflowTemplateFromOriginFlow(originFlowEnvelope);
  if (!template) {
    return contextForClient(clientKeyFromRequest(req));
  }

  return saveContextForClient(clientKeyFromRequest(req), { workflowTemplate: template });
}

async function captureLatestOriginWorkflowTemplate(req, originEnvelope) {
  const processId = latestOriginProcessId(originEnvelope);
  if (!processId) {
    return contextForClient(clientKeyFromRequest(req));
  }

  const localOrigin = `http://${req.headers.host || `127.0.0.1:${port}`}`;
  const flowUrl = new URL(flowRecordEndpoint, localOrigin);
  flowUrl.searchParams.set('processId', processId);
  const remoteResponse = await fetchTarget(req, flowUrl, null, undefined, 'GET');
  if (remoteResponse.status >= 400) {
    return contextForClient(clientKeyFromRequest(req));
  }

  const remoteType = headerValue(remoteResponse.headers, 'content-type') || 'application/json; charset=utf-8';
  if (!isTextualContentType(remoteType)) {
    return contextForClient(clientKeyFromRequest(req));
  }

  return saveWorkflowTemplateForClient(req, JSON.parse(remoteResponse.body.toString('utf8')));
}

async function handleSubmitForm(req, res, reqUrl) {
  const body = await readRequestBody(req);
  const payload = parseJsonBody(body);
  validateApplication(payload);

  const clientKey = clientKeyFromRequest(req);
  const userContext = await ensureUserContext(req);

  if (forwardSubmit) {
    const remoteResponse = await fetchTarget(req, reqUrl, null, body);
    const remoteType = headerValue(remoteResponse.headers, 'content-type') || 'application/json; charset=utf-8';
    if (isTextualContentType(remoteType)) {
      const rewritten = rewriteTextForLocalOrigin(remoteResponse.body.toString('utf8'), req);
      const bytes = Buffer.from(rewritten, 'utf8');
      res.writeHead(remoteResponse.status, responseHeaders(remoteResponse, bytes.length, true));
      res.end(bytes);
      return;
    }

    const bytes = remoteResponse.body;
    res.writeHead(remoteResponse.status, responseHeaders(remoteResponse, bytes.length, false));
    res.end(bytes);
    return;
  }

  saveApplication(applicationsPath, payload, {
    ...userContext,
    clientKey,
  });

  res.setHeader('x-leave-system-mode', 'local-only');
  sendJson(res, 200, {
    code: 0,
    msg: 'success',
    data: {},
    localOnly: true,
    mode: 'local-only',
  });
}

async function handleGetMyApply(req, res, reqUrl) {
  const body = await readRequestBody(req);
  const query = parseJsonBody(body);
  const clientKey = clientKeyFromRequest(req);
  if (clientKey === 'default') throw httpError(401, 'Authentication required');

  const cachedContext = contextForClient(clientKey);
  let userContext = contextHasIdentity(cachedContext) ? cachedContext : {};
  const initialLocalApplications = localApplicationsForClient(req, userContext);
  const localRecordsForPaging = recordsFromApplications(initialLocalApplications, userContext);
  const originQuery = originQueryForMergedPage(query, localRecordsForPaging.length);
  const originBody = Buffer.from(JSON.stringify(originQuery), 'utf8');

  try {
    // Let the origin authenticate this request directly, matching the original application flow.
    const remoteResponse = await fetchTarget(req, reqUrl, null, originBody);
    if (remoteResponse.status >= 400) {
      throw new Error('Origin getMyApply returned HTTP ' + remoteResponse.status);
    }

    const remoteType = headerValue(remoteResponse.headers, 'content-type') || 'application/json; charset=utf-8';
    if (!isTextualContentType(remoteType)) {
      await proxyToTarget(req, res, reqUrl, null, originBody);
      return;
    }

    const originEnvelope = JSON.parse(remoteResponse.body.toString('utf8'));
    const derivedContext = deriveUserContextFromOriginRecords(originEnvelope);
    userContext = saveContextForClient(clientKey, derivedContext);
    try {
      userContext = await captureLatestOriginWorkflowTemplate(req, originEnvelope);
    } catch {
      // Keep the most recently saved template when the optional origin detail lookup fails.
    }

    const localApplications = localApplicationsForClient(req, userContext);
    const localRecords = recordsFromApplications(localApplications, userContext);
    const mergedEnvelope = mergeRecords(originEnvelope, localRecords, query);
    sendJson(res, remoteResponse.status, mergedEnvelope);
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) throw error;
    // If the origin is temporarily unavailable, keep the logged-in session usable with local records.
    const localRecords = currentLocalRecords(req, userContext);
    sendJson(res, 200, {
      ...createLocalOnlyApplyResponse(localRecords, query),
      localOnly: true,
      mode: 'local-only',
    });
  }
}

async function handleBaseData(req, res, reqUrl) {
  const remoteResponse = await fetchTarget(req, reqUrl, null);
  const remoteType = headerValue(remoteResponse.headers, 'content-type') || 'application/json; charset=utf-8';
  const clientKey = clientKeyFromRequest(req);
  if (isTextualContentType(remoteType) && clientKey !== 'default') {
    try {
      const originEnvelope = JSON.parse(remoteResponse.body.toString('utf8'));
      saveContextForClient(clientKey, userContextFromBaseData(originEnvelope));
    } catch {
      // Keep proxying the origin response even if local context extraction fails.
    }
  }

  const textual = isTextualContentType(remoteType);
  if (textual) {
    const rewritten = rewriteTextForLocalOrigin(remoteResponse.body.toString('utf8'), req);
    const bytes = Buffer.from(rewritten, 'utf8');
    res.writeHead(remoteResponse.status, responseHeaders(remoteResponse, bytes.length, true));
    res.end(bytes);
    return;
  }

  const bytes = remoteResponse.body;
  res.writeHead(remoteResponse.status, responseHeaders(remoteResponse, bytes.length, false));
  res.end(bytes);
}

function localIdFromRequest(reqUrl, names) {
  for (const name of names) {
    const value = reqUrl.searchParams.get(name);
    if (value?.startsWith('local-')) {
      return value;
    }
  }
  return '';
}

async function handleLocalDetail(req, res, reqUrl) {
  if (req.method !== 'GET') {
    return false;
  }

  if (reqUrl.pathname === submitInfoEndpoint) {
    const localId = localIdFromRequest(reqUrl, ['submitId']);
    if (!localId) return false;
    const entry = await findLocalApplicationWithContext(req, localId);
    if (!entry) { sendJson(res, 404, { ok: false, message: 'Record not found' }); return true; }
    const submitInfo = buildLocalSubmitInfo(entry, req.verifiedContext || contextForClient(clientKeyFromRequest(req)));
    sendJson(res, 200, {
      code: 0,
      msg: 'success',
      data: detailPageData(submitInfo),
    });
    return true;
  }

  if (reqUrl.pathname === flowRecordEndpoint) {
    const localId = localIdFromRequest(reqUrl, ['processId']);
    if (!localId) return false;
    const entry = await findLocalApplicationWithContext(req, localId);
    if (!entry) { sendJson(res, 404, { ok: false, message: 'Record not found' }); return true; }
    const flowRecord = buildLocalFlowRecord(entry, req.verifiedContext || contextForClient(clientKeyFromRequest(req)));
    sendJson(res, 200, {
      code: 0,
      msg: 'success',
      data: detailPageData(flowRecord),
    });
    return true;
  }

  if (reqUrl.pathname === workflowStatusEndpoint) {
    const localId = localIdFromRequest(reqUrl, ['processId']);
    if (!localId) return false;
    const entry = await findLocalApplicationWithContext(req, localId);
    if (!entry) { sendJson(res, 404, { ok: false, message: 'Record not found' }); return true; }
    const workflowStatus = buildLocalWorkflowStatus();
    sendJson(res, 200, {
      code: 0,
      msg: 'success',
      data: detailPageData(workflowStatus),
    });
    return true;
  }

  return false;
}

async function handleLocalApi(req, res, reqUrl) {
  if (reqUrl.pathname === '/api/records' && req.method === 'GET') {
    const userContext = await ensureUserContext(req);
    sendJson(res, 200, {
      ok: true,
      status: 'local-json-active',
      records: currentLocalRecords(req, userContext),
    });
    return true;
  }

  if (reqUrl.pathname === '/api/applications' && req.method === 'POST') {
    const body = await readRequestBody(req);
    const payload = parseJsonBody(body);
    validateApplication(payload);
    const userContext = await ensureUserContext(req);
    const clientKey = clientKeyFromRequest(req);
    const entry = saveApplication(applicationsPath, payload, {
      ...userContext,
      clientKey,
    });
    sendJson(res, 200, {
      ok: true,
      status: 'local-json-active',
      localOnly: true,
      mode: 'local-only',
      application: entry,
    });
    return true;
  }

  if (reqUrl.pathname.startsWith('/api/')) {
    sendJson(res, 404, {
      ok: false,
      message: 'Unknown local API',
    });
    return true;
  }

  return false;
}

function validateApplication(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(400, 'Application payload must be an object');
  }
  if (!String(payload.formId || '').trim() || !payload.params || typeof payload.params !== 'object' || Array.isArray(payload.params)) {
    throw httpError(400, 'formId and params are required');
  }

  const parseTime = (value) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') {
      const timestamp = new Date(value).getTime();
      if (!Number.isFinite(timestamp)) throw httpError(400, 'Invalid leave time');
      return timestamp;
    }
    if (typeof value !== 'string') throw httpError(400, 'Invalid leave time');

    const trimmed = value.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/);
    const normalized = match
      ? trimmed.replace(' ', 'T') + (trimmed.split(':').length === 3 ? '+08:00' : ':00+08:00')
      : trimmed;
    const timestamp = Date.parse(normalized);
    if (!Number.isFinite(timestamp)) throw httpError(400, 'Invalid leave time');
    return timestamp;
  };

  const begin = parseTime(payload.params.gatewayTransitBeginTime);
  const end = parseTime(payload.params.gatewayTransitEndTime);
  if (begin !== null && end !== null && end <= begin) {
    throw httpError(400, 'Leave end time must be after start time');
  }
}

function isSafeWriteRequest(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const originHost = new URL(origin).host;
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const requestHosts = [req.headers.host, forwardedHost].filter(Boolean);
    return requestHosts.includes(originHost);
  } catch {
    return false;
  }
}

try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch (error) {
  console.error('[leave-system] cannot create data directory:', error);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  try {
    if (!fs.existsSync(liveDir)) {
      sendText(res, 500, 'Missing leave-system-live-copy. Run: node scripts/generate-live-copy.mjs');
      return;
    }

    const reqUrl = new URL(req.url || '/', 'http://' + (req.headers.host || '127.0.0.1'));

    if (reqUrl.pathname === '/healthz' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, service: 'leave-system' });
      return;
    }

    if (req.method === 'GET') {
      let decodedPathname = reqUrl.pathname;
      try {
        decodedPathname = decodeURIComponent(reqUrl.pathname);
      } catch {
        // Keep the original pathname if the browser sends an invalid escape sequence.
      }

      if (/\.js\.\u4e0b\u8f7d$/u.test(decodedPathname)) {
        reqUrl.pathname = decodedPathname.replace(/\.js\.\u4e0b\u8f7d$/u, '.js');
        redirect(res, `${reqUrl.pathname}${reqUrl.search}`);
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isSafeWriteRequest(req)) {
      throw httpError(403, 'Cross-origin writes are not allowed');
    }

    if (req.method === 'GET' && liveAppShellPaths.has(reqUrl.pathname)) {
      await serveCurrentOriginAppShell(req, res);
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === submitEndpoint) {
      await handleSubmitForm(req, res, reqUrl);
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === myApplyEndpoint) {
      await handleGetMyApply(req, res, reqUrl);
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === baseDataEndpoint) {
      await handleBaseData(req, res, reqUrl);
      return;
    }

    if (await handleLocalDetail(req, res, reqUrl)) {
      return;
    }

    if (await handleLocalApi(req, res, reqUrl)) {
      return;
    }

    const localPath = safeLocalPath(reqUrl.pathname);
    const localFilePath = localPath && fs.existsSync(localPath) ? localPath : savedScriptVariant(localPath);
    if (localFilePath && fs.existsSync(localFilePath) && fs.statSync(localFilePath).isFile()) {
      await serveLocalFile(req, res, localFilePath);
      return;
    }

    await proxyToTarget(req, res, reqUrl, localPath);
  } catch (error) {
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }

    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    if (status >= 500) console.error('[leave-system] request failed:', message);
    sendJson(res, status, {
      ok: false,
      message: status >= 500 ? 'Service temporarily unavailable' : message,
    });
  }
});

server.requestTimeout = 60000;
server.headersTimeout = 15000;
server.on('error', (error) => {
  console.error('[leave-system] server failed:', error);
  process.exit(1);
});

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

server.listen(port, host, () => {
  console.log('Live copy server running at http://' + host + ':' + port + '/index.html#/pages/login/login?unionid=2508330129619148941&schoolCode=qt036');
  console.log('Proxy target: ' + targetOrigin);
  console.log('Submit mode: ' + (forwardSubmit ? 'origin-forwarding' : 'local-only'));
});
