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
const dataDir = path.join(root, 'data');
const applicationsPath = path.join(dataDir, 'applications.json');
const userContextsPath = path.join(dataDir, 'user-contexts.json');
const defaultTarget = 'http://esp.qmxy.com';
const submitEndpoint = '/api-general/ScBusinessFormSubmit/submitForm';
const myApplyEndpoint = '/api-general/approvalCenter/getMyApply';
const baseDataEndpoint = '/api-general/account/getIndexDataComm';
const submitInfoEndpoint = '/api-general/ScBusinessFormSubmit/querySubmitInfo';
const flowRecordEndpoint = '/api-general/workflow/flowRecord';
const workflowStatusEndpoint = '/api-general/workflow/app/status';
const detailBundleName = 'pages-tool-approvalDetailPage-approvalDetailPage.d46ed04c.js';
const detailBundleVersion = '20260611-local-detail';

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
  for await (const chunk of req) {
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

  return JSON.parse(text);
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
    .replaceAll(detailBundleName, `${detailBundleName}?local-detail-v=${detailBundleVersion}`)
    .replaceAll('http://esp.qmxy.com', localOrigin)
    .replaceAll('https://esp.qmxy.com', localOrigin);
  const reqUrl = new URL(req.url || '/', localOrigin);
  if (reqUrl.pathname.includes('pages-tool-approvalDetailPage-approvalDetailPage.d46ed04c.js')) {
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
  const tempPath = `${storagePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, storagePath);
}

function cleanContext(context = {}) {
  const cleaned = {};
  for (const key of ['name', 'userName', 'studentNo', 'userNo', 'collegeName', 'majorName', 'className', 'clazzName', 'departmentName', 'formName']) {
    const value = context[key];
    if (typeof value === 'string' && value.trim() && value.trim() !== '--') {
      cleaned[key] = value.trim();
    }
  }
  return cleaned;
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
  if (!Object.keys(cleaned).length) {
    return contextForClient(clientKey);
  }

  const contexts = loadJsonObject(userContextsPath);
  const existing = contexts[clientKey] || {};
  const merged = {
    ...mergeUserContexts(cleaned, existing),
    updatedAt: new Date().toISOString(),
  };
  contexts[clientKey] = merged;
  saveJsonObject(userContextsPath, contexts);
  return merged;
}

async function ensureUserContext(req) {
  const clientKey = clientKeyFromRequest(req);
  const existing = contextForClient(clientKey);
  if (contextHasIdentity(existing)) {
    return existing;
  }

  try {
    const reqUrl = new URL(baseDataEndpoint, `http://${req.headers.host || '127.0.0.1'}`);
    const remoteResponse = await fetchTarget(req, reqUrl, null);
    const remoteType = headerValue(remoteResponse.headers, 'content-type') || 'application/json; charset=utf-8';
    if (!isTextualContentType(remoteType)) {
      return existing;
    }

    const originEnvelope = JSON.parse(remoteResponse.body.toString('utf8'));
    return saveContextForClient(clientKey, userContextFromBaseData(originEnvelope));
  } catch {
    return existing;
  }
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
  const scopedEntry = findApplicationByLocalId(localApplicationsForClient(req), localId, context);
  if (scopedEntry) {
    return scopedEntry;
  }

  const allApplications = loadApplications(applicationsPath);
  const rawEntry = allApplications.find((entry) => [entry.id, entry.record?.submitId, entry.record?.processId, entry.record?.taskId].includes(localId));
  if (!rawEntry) {
    return null;
  }

  const ownerContext = rawEntry.clientKey ? contextForClient(rawEntry.clientKey) : {};
  return findApplicationByLocalId([rawEntry], localId, mergeUserContexts(context, ownerContext));
}

function responseHeaders(remoteResponse, bodyLength, textual) {
  const headers = {};
  for (const [key, value] of Object.entries(remoteResponse.headers)) {
    const lower = key.toLowerCase();
    if (['content-length', 'transfer-encoding', 'content-encoding', 'connection', 'keep-alive'].includes(lower)) {
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
      .replace(/;\s*Secure/ig, ''));
  }

  if (textual && !headers['content-type']) {
    headers['content-type'] = 'text/plain; charset=utf-8';
  }
  headers['content-length'] = String(bodyLength);
  headers['cache-control'] = 'no-store';
  return headers;
}

function requestViaNode(remoteUrl, { method, headers, body }) {
  const proxyEnv = remoteUrl.protocol === 'https:'
    ? process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    : process.env.HTTP_PROXY;
  const proxyUrl = proxyEnv ? new URL(proxyEnv) : null;

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
      remoteRes.on('data', (chunk) => chunks.push(chunk));
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
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lower)) {
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

async function fetchTarget(req, reqUrl, localPath, bodyOverride) {
  const remoteUrl = remoteUrlFor(reqUrl, localPath);
  const body = bodyOverride ?? (['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : await readRequestBody(req));
  const headers = targetRequestHeaders(req, body);

  return requestViaNode(remoteUrl, {
    method: req.method || 'GET',
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

async function handleSubmitForm(req, res) {
  const body = await readRequestBody(req);
  const payload = parseJsonBody(body);
  const clientKey = clientKeyFromRequest(req);
  const userContext = await ensureUserContext(req);
  saveApplication(applicationsPath, payload, {
    ...userContext,
    clientKey,
  });

  sendJson(res, 200, {
    code: 0,
    msg: 'success',
    data: {},
  });
}

async function handleGetMyApply(req, res, reqUrl) {
  const body = await readRequestBody(req);
  const query = parseJsonBody(body);
  const clientKey = clientKeyFromRequest(req);
  const initialContext = contextForClient(clientKey);
  const initialLocalApplications = localApplicationsForClient(req, initialContext);
  const localRecordsForPaging = recordsFromApplications(initialLocalApplications, initialContext);
  const originQuery = originQueryForMergedPage(query, localRecordsForPaging.length);
  const originBody = Buffer.from(JSON.stringify(originQuery), 'utf8');

  try {
    const remoteResponse = await fetchTarget(req, reqUrl, null, originBody);
    if (remoteResponse.status >= 400) {
      throw new Error(`Origin getMyApply returned HTTP ${remoteResponse.status}`);
    }

    const remoteType = headerValue(remoteResponse.headers, 'content-type') || 'application/json; charset=utf-8';
    if (!isTextualContentType(remoteType)) {
      await proxyToTarget(req, res, reqUrl, null, originBody);
      return;
    }

    const originEnvelope = JSON.parse(remoteResponse.body.toString('utf8'));
    const derivedContext = deriveUserContextFromOriginRecords(originEnvelope);
    const userContext = saveContextForClient(clientKey, derivedContext);
    const localApplications = localApplicationsForClient(req, userContext);
    const localRecords = recordsFromApplications(localApplications, userContext);
    const mergedEnvelope = mergeRecords(originEnvelope, localRecords, query);
    sendJson(res, remoteResponse.status, mergedEnvelope);
  } catch (error) {
    const localRecords = currentLocalRecords(req);
    sendJson(res, 200, createLocalOnlyApplyResponse(localRecords, query));
  }
}

async function handleBaseData(req, res, reqUrl) {
  const remoteResponse = await fetchTarget(req, reqUrl, null);
  const remoteType = headerValue(remoteResponse.headers, 'content-type') || 'application/json; charset=utf-8';
  if (isTextualContentType(remoteType)) {
    try {
      const originEnvelope = JSON.parse(remoteResponse.body.toString('utf8'));
      saveContextForClient(clientKeyFromRequest(req), userContextFromBaseData(originEnvelope));
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
    if (!entry) return false;
    const submitInfo = buildLocalSubmitInfo(entry, contextForClient(clientKeyFromRequest(req)));
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
    if (!entry) return false;
    const flowRecord = buildLocalFlowRecord(entry, contextForClient(clientKeyFromRequest(req)));
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
    sendJson(res, 200, {
      ok: true,
      status: 'local-json-active',
      records: currentLocalRecords(req),
    });
    return true;
  }

  if (reqUrl.pathname === '/api/applications' && req.method === 'POST') {
    const body = await readRequestBody(req);
    const payload = parseJsonBody(body);
    const clientKey = clientKeyFromRequest(req);
    const entry = saveApplication(applicationsPath, payload, {
      ...contextForClient(clientKey),
      clientKey,
    });
    sendJson(res, 200, {
      ok: true,
      status: 'local-json-active',
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

const server = http.createServer(async (req, res) => {
  try {
    if (!fs.existsSync(liveDir)) {
      sendText(res, 500, 'Missing leave-system-live-copy. Run: node scripts/generate-live-copy.mjs');
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

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
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === submitEndpoint) {
      await handleSubmitForm(req, res);
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
    sendJson(res, 502, {
      ok: false,
      message: 'Live proxy request failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Live copy server running at http://${host}:${port}/index.html#/pages/login/login?unionid=2508330129619148941&schoolCode=qt036`);
  console.log(`Proxy target: ${targetOrigin}`);
});
