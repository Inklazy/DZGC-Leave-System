import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './project-root.mjs';

const headers = {
  'content-type': 'application/json',
  cookie: 'codex-local-test=utf8-file',
};
const alternateHeaders = {
  cookie: 'codex-local-test=direct-detail',
};
const reloginHeaders = {
  'content-type': 'application/json',
  cookie: 'codex-local-test=utf8-file-relogin',
};
const otherAccountHeaders = {
  'content-type': 'application/json',
  cookie: 'codex-local-test=utf8-file-other-account',
};
const applicationsPath = path.join(root, 'data', 'applications.json');
const userContextsPath = path.join(root, 'data', 'user-contexts.json');
const testClientKey = crypto.createHash('sha256').update(headers.cookie).digest('hex').slice(0, 16);
const reloginClientKey = crypto.createHash('sha256').update(reloginHeaders.cookie).digest('hex').slice(0, 16);
const otherAccountClientKey = crypto.createHash('sha256').update(otherAccountHeaders.cookie).digest('hex').slice(0, 16);
const testDescription = '接口级本地提交测试';

const indexHtml = await fetch('http://127.0.0.1:8123/index.html').then((response) => response.text());
const entryScriptSrc = [...indexHtml.matchAll(/<script\b[^>]*type=["']module["'][^>]*src=["']([^"']*index-ebfab978\.js[^"']*)["']/gi)][0]?.[1];
assert.ok(entryScriptSrc, 'Expected live index.html to include the original Vue entry script');
assert.ok(!/\.js\.[^/"']+$/u.test(entryScriptSrc), `Entry script URL must be normalized to one module identity: ${entryScriptSrc}`);
const entryScriptResponse = await fetch(new URL(entryScriptSrc, 'http://127.0.0.1:8123/index.html'));
assert.equal(entryScriptResponse.status, 200);
const entryScriptText = await entryScriptResponse.text();
assert.match(entryScriptText, /window\.__uniRoutes/);
assert.match(
  entryScriptText,
  /pages-tool-approvalDetailPage-approvalDetailPage\.d46ed04c\.js\?local-detail-v=/u,
);
const legacyEntryScriptResponse = await fetch(
  new URL(entryScriptSrc.replace(/\.js$/u, '.js.下载'), 'http://127.0.0.1:8123/index.html'),
  { redirect: 'manual' },
);
assert.equal(legacyEntryScriptResponse.status, 302);
assert.match(legacyEntryScriptResponse.headers.get('location') || '', /index-ebfab978\.js$/u);

function loadStoredApplications() {
  if (!fs.existsSync(applicationsPath)) {
    return [];
  }
  const raw = fs.readFileSync(applicationsPath, 'utf8').trim();
  return raw ? JSON.parse(raw) : [];
}

function loadStoredUserContexts() {
  if (!fs.existsSync(userContextsPath)) {
    return {};
  }
  const raw = fs.readFileSync(userContextsPath, 'utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function saveStoredUserContexts(contexts) {
  fs.mkdirSync(path.dirname(userContextsPath), { recursive: true });
  fs.writeFileSync(userContextsPath, `${JSON.stringify(contexts, null, 2)}\n`, 'utf8');
}

function cleanupTestApplications() {
  if (!fs.existsSync(applicationsPath)) {
    return;
  }

  const applications = loadStoredApplications();
  const filtered = applications.filter((entry) => entry.payload?.params?.shiyoumiaoshu !== testDescription);
  if (filtered.length !== applications.length) {
    fs.writeFileSync(applicationsPath, `${JSON.stringify(filtered, null, 2)}\n`, 'utf8');
  }
}

function cleanupTestUserContexts() {
  const contexts = loadStoredUserContexts();
  let changed = false;
  for (const key of [testClientKey, reloginClientKey, otherAccountClientKey]) {
    if (Object.hasOwn(contexts, key)) {
      delete contexts[key];
      changed = true;
    }
  }
  if (changed) {
    saveStoredUserContexts(contexts);
  }
}

cleanupTestApplications();
cleanupTestUserContexts();

const payload = {
  formId: '100017',
  businessNo: 'BM5017',
  subClient: 'apph5_internal_student',
  params: {
    flowRecords: [],
    name: '张三',
    userNo: '20260001',
    className: '软件一班',
    gatewayTransitBeginTime: '2026-06-11 19:15:57',
    gatewayTransitEndTime: '2026-06-11 23:59:59',
    approvalTrendId: ['3'],
    gatewayTransitType: '8',
    shiyoumiaoshu: testDescription,
    benrenchengnuo: ['1'],
  },
  formVersion: 1,
};

function seedTestUserContexts() {
  const contexts = loadStoredUserContexts();
  const baseContext = {
    name: payload.params.name,
    studentNo: payload.params.userNo,
    className: payload.params.className,
    formName: '鍑哄叆鐢宠',
    updatedAt: new Date().toISOString(),
  };
  contexts[testClientKey] = baseContext;
  contexts[reloginClientKey] = {
    ...baseContext,
    updatedAt: new Date().toISOString(),
  };
  contexts[otherAccountClientKey] = {
    ...baseContext,
    name: '鏉庡洓',
    studentNo: '20260002',
    className: '杞欢浜岀彮',
    updatedAt: new Date().toISOString(),
  };
  saveStoredUserContexts(contexts);
}

seedTestUserContexts();

const submit = await fetch('http://127.0.0.1:8123/api-general/ScBusinessFormSubmit/submitForm', {
  method: 'POST',
  headers,
  body: JSON.stringify(payload),
}).then((response) => response.json());

const pass = await fetch('http://127.0.0.1:8123/api-general/approvalCenter/getMyApply', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    page_index: 1,
    page_size: 5,
    search: {
      processStatusList: ['2'],
      businessNoList: ['BM5017'],
    },
  }),
}).then((response) => response.json());

const doing = await fetch('http://127.0.0.1:8123/api-general/approvalCenter/getMyApply', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    page_index: 1,
    page_size: 5,
    search: {
      processStatusList: [1],
      businessNoList: ['BM5017'],
    },
  }),
}).then((response) => response.json());

const reloginPass = await fetch('http://127.0.0.1:8123/api-general/approvalCenter/getMyApply', {
  method: 'POST',
  headers: reloginHeaders,
  body: JSON.stringify({
    page_index: 1,
    page_size: 5,
    search: {
      processStatusList: ['2'],
      businessNoList: ['BM5017'],
    },
  }),
}).then((response) => response.json());

const otherAccountPass = await fetch('http://127.0.0.1:8123/api-general/approvalCenter/getMyApply', {
  method: 'POST',
  headers: otherAccountHeaders,
  body: JSON.stringify({
    page_index: 1,
    page_size: 5,
    search: {
      processStatusList: ['2'],
      businessNoList: ['BM5017'],
    },
  }),
}).then((response) => response.json());

const localRecord = pass.data.records.find((record) => record.submitId?.startsWith('local-'));
if (!localRecord) {
  throw new Error('Expected a local record in approved list');
}

function detailLabels(submitInfoData) {
  return new Map(
    submitInfoData.itemList
      .flatMap((panel) => panel.children || [])
      .flatMap((item) => item.children || [item])
      .map((item) => [item.itemName, submitInfoData.submit[item.itemField]]),
  );
}

const paramLabels = new Map(localRecord.paramList.map((item) => [item.label, item.value]));
assert.equal(localRecord.title2, '张三 发起的申请');
assert.equal(paramLabels.get('学号'), '20260001');
assert.equal(paramLabels.get('班级'), '软件一班');
assert.equal(paramLabels.get('进出事由'), '其他');
assert.equal(paramLabels.get('申请动向'), '申请宿舍免查寝');
assert.equal(paramLabels.has('事由描述'), false);
assert.equal(doing.data.records.length, 0);
assert.ok(reloginPass.data.records.some((record) => record.submitId === localRecord.submitId));
assert.ok(!otherAccountPass.data.records.some((record) => record.submitId === localRecord.submitId));

const submitInfo = await fetch(`http://127.0.0.1:8123/api-general/ScBusinessFormSubmit/querySubmitInfo?submitId=${localRecord.submitId}`, {
  headers,
}).then((response) => response.json());

const flowRecord = await fetch(`http://127.0.0.1:8123/api-general/workflow/flowRecord?processId=${localRecord.processId}`, {
  headers,
}).then((response) => response.json());

const workflowStatus = await fetch(`http://127.0.0.1:8123/api-general/workflow/app/status?processId=${localRecord.processId}&taskId=${localRecord.taskId}`, {
  headers,
}).then((response) => response.json());

assert.equal(submitInfo.code, 0);
assert.equal(submitInfo.data.submit.processStatus, '2');
assert.equal(submitInfo.data.data.submit.processStatus, '2');
assert.deepEqual(submitInfo.data.itemList.map((panel) => panel.itemName), ['申请人信息', '申请时间', '申请理由']);
assert.deepEqual(submitInfo.data.data.itemList.map((panel) => panel.itemName), ['申请人信息', '申请时间', '申请理由']);
const detailValues = detailLabels(submitInfo.data);
assert.equal(detailValues.get('姓名'), '张三');
assert.equal(detailValues.get('学号'), '20260001');
assert.equal(detailValues.get('学院'), '数字商贸学院-高职');
assert.equal(detailValues.get('专业'), '软件一班');
assert.equal(detailValues.get('班级'), '软件一班');
assert.equal(detailValues.get('进出事由'), '其他');
assert.equal(detailValues.get('申请动向'), '申请宿舍免查寝');
assert.equal(detailValues.get('事由描述'), testDescription);

const directSubmitInfo = await fetch(`http://127.0.0.1:8123/api-general/ScBusinessFormSubmit/querySubmitInfo?submitId=${localRecord.submitId}`, {
  headers: alternateHeaders,
}).then((response) => response.json());
assert.equal(directSubmitInfo.code, 0);
assert.equal(detailLabels(directSubmitInfo.data).get('学号'), '20260001');
assert.equal(detailLabels(directSubmitInfo.data.data).get('学号'), '20260001');

assert.equal(flowRecord.code, 0);
assert.equal(flowRecord.data.processStatus, '2');
assert.equal(flowRecord.data.data.processStatus, '2');
assert.deepEqual(flowRecord.data.actList.map((node) => node.actName), ['班主任', '抄送通知']);
assert.deepEqual(flowRecord.data.data.actList.map((node) => node.actName), ['班主任', '抄送通知']);
assert.equal(flowRecord.data.actList[0].multiTypeId, 2);
assert.equal(flowRecord.data.actList[0].taskList.filter((task) => task.handleType === 1).length, 1);
assert.ok(['王彤彤', '赵志慧'].includes(flowRecord.data.actList[0].taskList.find((task) => task.handleType === 1).handleUserName));
assert.deepEqual(flowRecord.data.actList[1].taskList.map((task) => task.handleUserName), ['杨保福', '杨振辉']);
assert.deepEqual({
  cancel: workflowStatus.data.cancel,
  approval: workflowStatus.data.approval,
  transfer: workflowStatus.data.transfer,
}, {
  cancel: false,
  approval: false,
  transfer: false,
});
assert.deepEqual(workflowStatus.data.data, {
  cancel: false,
  approval: false,
  transfer: false,
});

console.log(JSON.stringify({
  submit,
  pass: pass.data,
  doing: doing.data,
  reloginPass: reloginPass.data,
  otherAccountPass: otherAccountPass.data,
  submitInfo: submitInfo.data,
  flowRecord: flowRecord.data,
  workflowStatus: workflowStatus.data,
}, null, 2));

cleanupTestApplications();
cleanupTestUserContexts();
