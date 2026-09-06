import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PASS_STATUS = '2';
const LOCAL_ID_PREFIX = 'local';
const DEFAULT_FORM_NAME = '出入申请';
const DEFAULT_PERSON_NAME = '我';
const DEFAULT_COLLEGE_NAME = '数字商贸学院-高职';
const DEFAULT_MAJOR_NAME = '网络营销与直播电商';
const EMPTY_VALUE = '--';
const APPROVER_TEACHERS = ['王彤彤', '赵志慧'];
const COPY_USERS = ['杨保福', '杨振辉'];

const TRANSIT_REASON_LABELS = {
  7: '事假',
  8: '其他',
};

const APPROVAL_TREND_LABELS = {
  1: '申请离校',
  2: '申请回宿',
  3: '申请宿舍免查寝',
  4: '申请上课免考勤',
};

const FIELD_DEFINITIONS = [
  {
    label: '表单',
    value: (_payload, _fields, context) => context.formName || DEFAULT_FORM_NAME,
  },
  {
    label: '学号',
    value: (_payload, fields, context) => context.studentNo || context.userNo || valueForKeys(fields, USER_KEYS),
    keys: ['userNo', 'studentNo', 'studentNumber', 'studentId', 'jobNo', 'workNo', 'personNo', 'account', 'accountNo'],
  },
  {
    label: '班级',
    value: (_payload, fields, context) => context.className || context.clazzName || context.departmentName || valueForKeys(fields, CLASS_KEYS),
    keys: ['className', 'clazzName', 'class', 'deptName', 'departmentName', 'orgName', 'collegeName'],
  },
  {
    label: '开始时间',
    keys: ['gatewayTransitBeginTime', 'gatewayTransitStartTime', 'beginTime', 'startTime', 'leaveStartTime'],
  },
  {
    label: '结束时间',
    keys: ['gatewayTransitEndTime', 'endTime', 'leaveEndTime'],
  },
  {
    label: '进出事由',
    value: (_payload, fields) => valueForKeys(fields, ['gatewayTransitReason', 'transitReason', 'reason', 'reasonType', 'leaveReason']) ||
      labelForCodeOrFallback(fields.get('gatewaytransittype'), TRANSIT_REASON_LABELS, '其他'),
  },
  {
    label: '申请动向',
    value: (_payload, fields, context) => valueForKeys(fields, ['applyMove', 'applyDirection', 'gatewayTransitDirection', 'direction', 'transitDirection', 'inOutType', 'moveType']) ||
      labelsForCodes(fields.get('approvaltrendid'), context.approvalTrendLabels || APPROVAL_TREND_LABELS),
  },
  {
    label: '事由描述',
    keys: ['shiyoumiaoshu', 'gatewayTransitDesc', 'gatewayTransitDescription', 'reasonDesc', 'description', 'remark', 'remarks', 'cause'],
  },
];

const NAME_KEYS = ['name', 'userName', 'studentName', 'realName', 'personName', 'applicantName', 'applyUserName'];
const USER_KEYS = ['userNo', 'studentNo', 'studentNumber', 'studentId', 'jobNo', 'workNo', 'personNo', 'account', 'accountNo'];
const CLASS_KEYS = ['className', 'clazzName', 'class', 'deptName', 'departmentName', 'orgName', 'collegeName'];
const COLLEGE_KEYS = ['collegeName', 'college', 'schoolName', 'school', 'facultyName'];
const MAJOR_KEYS = ['majorName', 'major', 'professionName', 'profession', 'specialtyName'];

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashId(parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map((part) => typeof part === 'string' ? part : stableStringify(part)).join('\n'))
    .digest('hex')
    .slice(0, 16);
}

function pad(number) {
  return String(number).padStart(2, '0');
}

function formatDateTime(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    return formatDateTime(new Date());
  }

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(':');
}

function compactString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(compactString).filter(Boolean).join('、');
  }
  if (typeof value === 'object') {
    for (const key of ['label', 'text', 'name', 'title', 'value', 'displayName']) {
      const nested = compactString(value[key]);
      if (nested) return nested;
    }
    return '';
  }
  return String(value).trim();
}

function pushField(fields, key, value) {
  if (!key) return;
  const cleanKey = String(key).trim();
  const cleanValue = compactString(value);
  if (!cleanKey || !cleanValue) return;
  const lowerKey = cleanKey.toLowerCase();
  if (!fields.has(lowerKey)) {
    fields.set(lowerKey, cleanValue);
  }
}

function collectFields(value, fields = new Map(), pathParts = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const key = item.key || item.name || item.field || item.prop || item.code || item.label || item.title;
        const fieldValue = item.value ?? item.val ?? item.text ?? item.labelValue ?? item.displayValue ?? item.nameValue;
        pushField(fields, key, fieldValue);
      }
      collectFields(item, fields, pathParts);
    }
    return fields;
  }

  if (!value || typeof value !== 'object') {
    return fields;
  }

  for (const [key, nested] of Object.entries(value)) {
    pushField(fields, key, nested);
    collectFields(nested, fields, [...pathParts, key]);
  }

  return fields;
}

function valueForKeys(fields, keys) {
  for (const key of keys) {
    const direct = fields.get(String(key).toLowerCase());
    if (direct) return direct;
  }
  return '';
}

function splitCodes(value) {
  if (Array.isArray(value)) {
    return value.flatMap(splitCodes);
  }
  return compactString(value)
    .split(/[,\u3001]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function labelForCode(value, labels = {}) {
  const code = splitCodes(value)[0];
  return code ? labels[String(code)] || '' : '';
}

function labelForCodeOrFallback(value, labels = {}, fallback = '') {
  const code = splitCodes(value)[0];
  if (!code) return '';
  return labels[String(code)] || fallback;
}

function labelsForCodes(value, labels = {}) {
  return splitCodes(value)
    .map((code) => labels[String(code)] || '')
    .filter(Boolean)
    .join(',');
}

function recordParamMap(record = {}) {
  const map = new Map();
  for (const item of record.paramList || []) {
    const label = compactString(item.label);
    const value = compactString(item.value);
    if (label && value && value !== EMPTY_VALUE) {
      map.set(label, value);
    }
  }
  return map;
}

function userContextFromRecord(record = {}) {
  const params = recordParamMap(record);
  const titleName = compactString(record?.title2).replace(/\s*发起的申请\s*$/u, '');
  return mergeContext({
    name: titleName,
    formName: params.get('表单'),
    studentNo: params.get('学号'),
    collegeName: params.get('学院'),
    majorName: params.get('专业'),
    className: params.get('班级'),
  });
}

function valueFromParamList(paramList = [], label) {
  const item = paramList.find((param) => compactString(param.label) === label);
  const value = compactString(item?.value);
  return value && value !== EMPTY_VALUE ? value : '';
}

function mergeContext(...contexts) {
  const merged = {};
  for (const context of contexts) {
    if (!context || typeof context !== 'object') continue;
    for (const [key, value] of Object.entries(context)) {
      const text = compactString(value);
      if (text && text !== EMPTY_VALUE && !merged[key]) {
        merged[key] = text;
      }
    }
  }
  return merged;
}

function titleFromPayload(payload, fields, userContext) {
  const name = userContext.name ||
    userContext.userName ||
    valueForKeys(fields, NAME_KEYS) ||
    DEFAULT_PERSON_NAME;
  return `${name} 发起的申请`;
}

function userKeyFromPayload(fields, userContext) {
  return userContext.userNo ||
    userContext.studentNo ||
    userContext.userKey ||
    valueForKeys(fields, USER_KEYS) ||
    'default';
}

function accountKeyFromContext(context = {}) {
  return compactString(context.userNo) ||
    compactString(context.studentNo) ||
    compactString(context.userKey);
}

function accountKeyFromEntry(entry = {}, clientContexts = {}) {
  const entryKey = compactString(entry.userKey);
  if (entryKey && entryKey !== 'default') {
    return entryKey;
  }

  const clientContext = entry.clientKey ? clientContexts[entry.clientKey] : null;
  return accountKeyFromContext(clientContext);
}

export function selectApplicationsForUser(applications = [], userContext = {}, clientContexts = {}) {
  const currentClientKey = compactString(userContext.clientKey || userContext.sessionKey);
  const currentUserKey = accountKeyFromContext(userContext);

  return applications.filter((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }

    const entryUserKey = accountKeyFromEntry(entry, clientContexts);
    if (currentUserKey && entryUserKey) {
      return entryUserKey === currentUserKey;
    }

    if (currentUserKey && compactString(entry.userKey) === currentUserKey) {
      return true;
    }

    if (currentClientKey && entry.clientKey) {
      return entry.clientKey === currentClientKey;
    }

    return !entry.clientKey && !entry.userKey;
  });
}

function normalizeParamList(payload, fields, userContext) {
  const context = {
    formName: userContext.formName || payload.formName || payload.title || DEFAULT_FORM_NAME,
    studentNo: userContext.studentNo || userContext.userNo,
    userNo: userContext.userNo,
    className: userContext.className || userContext.clazzName,
    clazzName: userContext.clazzName,
    departmentName: userContext.departmentName,
    approvalTrendLabels: userContext.approvalTrendLabels,
  };

  return FIELD_DEFINITIONS.map((definition) => {
    const value = typeof definition.value === 'function'
      ? definition.value(payload, fields, context)
      : valueForKeys(fields, definition.keys || []);

    return {
      label: definition.label,
      value: value || EMPTY_VALUE,
    };
  });
}

function applicantNameForRecord(record = {}, fields = new Map(), userContext = {}) {
  return userContext.name ||
    userContext.userName ||
    valueForKeys(fields, NAME_KEYS) ||
    compactString(record.title2).replace(/\s*发起的申请\s*$/u, '') ||
    DEFAULT_PERSON_NAME;
}

function inferMajorName(context = {}, className = '', fields = new Map()) {
  const explicit = context.majorName || valueForKeys(fields, MAJOR_KEYS);
  if (explicit) return explicit;

  const classText = compactString(className);
  if (!classText) return DEFAULT_MAJOR_NAME;

  const yearClassMatch = classText.match(/^\d{4}级(.+?)(?:\d+班)$/u);
  if (yearClassMatch?.[1]) {
    return yearClassMatch[1];
  }

  return classText;
}

function createdDate(entry = {}) {
  const date = new Date(entry.createdAt || entry.updatedAt || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/**
 * Gives each local application a stable, realistic-looking approval delay.
 * It is derived from the local ID so revisiting a record never changes it.
 */
export function approvalDelaySeconds(entry = {}) {
  const key = entry.id || entry.createdAt || entry.updatedAt || 'local-application';
  const hashPrefix = hashId([key, 'approval-delay']).slice(0, 8);
  return 10 + (Number.parseInt(hashPrefix, 16) % 21);
}

export function localApprovalTime(entry = {}) {
  const approvedAt = new Date(createdDate(entry).getTime() + approvalDelaySeconds(entry) * 1000);
  return formatDateTime(approvedAt);
}

function timeValue(record) {
  const raw = record.title1 || record.submitTime || record.submit_time || record.createdAt || record.createTime || '';
  if (typeof raw === 'number') return raw;
  const text = String(raw);
  const normalized = text.replace('年', '-').replace('月', '-').replace('日', '').replace(/\//g, '-');
  const match = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+|T)?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?/u);
  if (!match) return 0;

  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
}

function shouldInjectApprovedRecords(query = {}) {
  const statusList = query.search?.processStatusList;
  if (!Array.isArray(statusList)) return false;
  return statusList.some((status) => String(status) === PASS_STATUS);
}

function pageInfo(query = {}) {
  const pageSize = Math.max(1, Number(query.page_size || query.pageSize || 10));
  const pageIndex = Math.max(1, Number(query.page_index || query.pageIndex || 1));
  return { pageIndex, pageSize };
}

function normalizeRecord(item) {
  return item && item.record ? item.record : item;
}

function recordForList(record = {}) {
  return {
    ...record,
    paramList: (record.paramList || []).filter((item) => compactString(item.label) !== '事由描述'),
  };
}

export function normalizeApplication(payload = {}, userContext = {}) {
  const now = userContext.now instanceof Date ? userContext.now : new Date(userContext.now || Date.now());
  const createdAt = now.toISOString();
  const title1 = formatDateTime(now);
  const fields = collectFields(payload);
  const id = `${LOCAL_ID_PREFIX}-${hashId([createdAt, payload, userContext.userKey || 'default'])}`;
  const record = {
    title1,
    title2: titleFromPayload(payload, fields, userContext),
    processStatus: PASS_STATUS,
    submitId: id,
    processId: id,
    taskId: id,
    paramList: normalizeParamList(payload, fields, userContext),
    localRecord: true,
  };

  return {
    id,
    createdAt,
    updatedAt: createdAt,
    status: 'approved',
    processStatus: PASS_STATUS,
    userKey: userKeyFromPayload(fields, userContext),
    clientKey: userContext.clientKey || userContext.sessionKey || null,
    payload,
    record,
  };
}

export function deriveUserContextFromOriginRecords(originResponse = {}) {
  const originData = originResponse?.data && typeof originResponse.data === 'object'
    ? originResponse.data
    : originResponse;
  const records = Array.isArray(originData?.records) ? originData.records : [];

  for (const record of records) {
    const context = userContextFromRecord(record);
    if (context.name || context.studentNo || context.className || context.formName) {
      return context;
    }
  }

  return {};
}

export function hydrateApplicationRecord(entry = {}, userContext = {}) {
  const payload = entry.payload || {};
  const normalized = normalizeApplication(payload, {
    ...userContext,
    clientKey: entry.clientKey,
    now: createdDate(entry),
    userKey: entry.userKey,
  });
  const id = entry.id || normalized.id;
  const createdAt = entry.createdAt || normalized.createdAt;
  const updatedAt = entry.updatedAt || normalized.updatedAt;

  return {
    ...entry,
    id,
    createdAt,
    updatedAt,
    status: entry.status || 'approved',
    processStatus: PASS_STATUS,
    userKey: entry.userKey || normalized.userKey,
    payload,
    record: {
      ...normalized.record,
      submitId: id,
      processId: id,
      taskId: id,
    },
  };
}

export function findApplicationByLocalId(applications = [], localId = '', userContext = {}) {
  if (!String(localId).startsWith(`${LOCAL_ID_PREFIX}-`)) {
    return null;
  }

  const entry = applications.find((item) => [item.id, item.record?.submitId, item.record?.processId, item.record?.taskId].includes(localId));
  return entry ? hydrateApplicationRecord(entry, userContext) : null;
}

function detailFieldName(label) {
  return `local_${crypto.createHash('sha1').update(label).digest('hex').slice(0, 10)}`;
}

function detailItem(label, value, submit) {
  const itemField = detailFieldName(label);
  submit[itemField] = value || EMPTY_VALUE;
  return {
    itemName: label,
    itemField,
    itemTypeId: '3',
    useStatusId: 1,
  };
}

function detailPanel(name, rows, submit) {
  return {
    itemName: name,
    itemField: detailFieldName(`panel:${name}`),
    itemTypeId: '80',
    useStatusId: 1,
    children: rows.map(([label, value]) => detailItem(label, value, submit)),
  };
}

export function buildLocalSubmitInfo(entry = {}, userContext = {}) {
  const hydrated = hydrateApplicationRecord(entry, mergeContext(userContext, userContextFromRecord(entry.record)));
  const paramList = hydrated.record.paramList || [];
  const fields = collectFields(hydrated.payload || {});
  const applicantName = applicantNameForRecord(hydrated.record, fields, userContext);
  const studentNo = userContext.studentNo ||
    userContext.userNo ||
    valueFromParamList(paramList, '学号') ||
    valueForKeys(fields, USER_KEYS) ||
    EMPTY_VALUE;
  const className = userContext.className ||
    userContext.clazzName ||
    valueFromParamList(paramList, '班级') ||
    valueForKeys(fields, CLASS_KEYS) ||
    EMPTY_VALUE;
  const collegeName = userContext.collegeName ||
    valueForKeys(fields, COLLEGE_KEYS) ||
    DEFAULT_COLLEGE_NAME;
  const majorName = inferMajorName(userContext, className, fields);
  const submit = {
    submitId: hydrated.id,
    processId: hydrated.id,
    taskId: hydrated.id,
    processStatus: PASS_STATUS,
    formName: userContext.formName || valueFromParamList(paramList, '表单') || DEFAULT_FORM_NAME,
  };

  return {
    submit,
    formName: submit.formName,
    itemList: [
      detailPanel('申请人信息', [
        ['姓名', applicantName],
        ['学号', studentNo],
        ['学院', collegeName],
        ['专业', majorName],
        ['班级', className],
      ], submit),
      detailPanel('申请时间', [
        ['开始时间', valueFromParamList(paramList, '开始时间')],
        ['结束时间', valueFromParamList(paramList, '结束时间')],
        ['申请动向', valueFromParamList(paramList, '申请动向')],
      ], submit),
      detailPanel('申请理由', [
        ['进出事由', valueFromParamList(paramList, '进出事由')],
        ['事由描述', valueFromParamList(paramList, '事由描述')],
      ], submit),
    ],
  };
}

function selectedApprover(id) {
  const index = Number.parseInt(hashId([id, 'approver']), 16) % APPROVER_TEACHERS.length;
  const approved = APPROVER_TEACHERS[index];
  return [
    approved,
    ...APPROVER_TEACHERS.filter((name) => name !== approved),
  ];
}

function flowDataFromEnvelope(envelope = {}) {
  const data = envelope?.data && typeof envelope.data === 'object'
    ? envelope.data
    : envelope;
  if (Array.isArray(data?.actList)) {
    return data;
  }
  if (Array.isArray(data?.data?.actList)) {
    return data.data;
  }
  return {};
}

function workflowTaskTemplate(task = {}) {
  return {
    handleUserName: compactString(task.handleUserName || task.userName || task.realName || task.name) || EMPTY_VALUE,
    handleTime: task.handleTime || task.approvalTime || task.handleDate || '',
    handleRemark: task.handleRemark || task.remark || task.comment || '',
    handleType: task.handleType ?? 0,
    isHandleDev: task.isHandleDev ?? 0,
  };
}

/**
 * Keeps the visible workflow shape from a real approved record while dropping
 * origin IDs so the template can be safely reused by a local application.
 */
export function deriveWorkflowTemplateFromOriginFlow(originResponse = {}) {
  const flowData = flowDataFromEnvelope(originResponse);
  if (!Array.isArray(flowData.actList) || !flowData.actList.length) {
    return null;
  }

  const actList = flowData.actList
    .filter((act) => act && typeof act === 'object')
    .map((act) => {
      return {
        actName: compactString(act.actName) || '审批',
        actTypeId: act.actTypeId ?? 1,
        multiTypeId: act.multiTypeId ?? 1,
        isFinish: act.isFinish ?? 1,
        handleType: act.handleType ?? 1,
        taskList: Array.isArray(act.taskList) ? act.taskList.map(workflowTaskTemplate) : [],
      };
    });

  return actList.length ? { actList } : null;
}

function localActListFromWorkflowTemplate(workflowTemplate, id, createdAt, approvedAt) {
  const template = deriveWorkflowTemplateFromOriginFlow(workflowTemplate);
  if (!template) {
    return [];
  }

  return template.actList.map((act, actIndex) => ({
    ...act,
    actId: `${id}-origin-act-${actIndex + 1}`,
    taskList: (act.taskList || []).map((task, taskIndex) => ({
      ...task,
      taskId: `${id}-origin-act-${actIndex + 1}-task-${taskIndex + 1}`,
      // Keep the original workflow people and outcome, but make a local
      // approval happen shortly after this local application was submitted.
      handleTime: Number(task.handleType) === 1
        ? approvedAt
        : task.handleTime || (Number(task.handleType) > 0 ? createdAt : ''),
    })),
  }));
}

export function buildLocalFlowRecord(entry = {}, userContext = {}) {
  const hydrated = hydrateApplicationRecord(entry, mergeContext(userContext, userContextFromRecord(entry.record)));
  const createdAt = formatDateTime(createdDate(hydrated));
  const approvedAt = localApprovalTime(hydrated);
  const teachers = selectedApprover(hydrated.id);
  const templateActList = localActListFromWorkflowTemplate(
    userContext.workflowTemplate,
    hydrated.id,
    createdAt,
    approvedAt,
  );

  return {
    submitId: hydrated.id,
    processId: hydrated.id,
    taskId: hydrated.id,
    businessNo: hydrated.payload?.businessNo,
    formId: hydrated.payload?.formId,
    processStatus: PASS_STATUS,
    actList: templateActList.length ? templateActList : [
      {
        actId: `${hydrated.id}-teacher`,
        actName: '班主任',
        actTypeId: 1,
        multiTypeId: 2,
        isFinish: 1,
        handleType: 1,
        taskList: teachers.map((teacher, index) => ({
          taskId: `${hydrated.id}-teacher-${index + 1}`,
          handleUserName: teacher,
          handleTime: index === 0 ? approvedAt : '',
          handleRemark: index === 0 ? '同意' : '',
          handleType: index === 0 ? 1 : 0,
          isHandleDev: 0,
        })),
      },
      {
        actId: `${hydrated.id}-copy`,
        actName: '抄送通知',
        actTypeId: 2,
        multiTypeId: 1,
        isFinish: 1,
        handleType: 4,
        taskList: COPY_USERS.map((user, index) => ({
          taskId: `${hydrated.id}-copy-${index + 1}`,
          handleUserName: user,
          handleTime: createdAt,
          handleRemark: '',
          handleType: 4,
          isHandleDev: 0,
        })),
      },
    ],
  };
}

export function buildLocalWorkflowStatus() {
  return {
    cancel: false,
    approval: false,
    transfer: false,
  };
}

export function mergeRecords(originResponse = {}, localRecords = [], query = {}) {
  const isEnvelope = originResponse && originResponse.data && typeof originResponse.data === 'object';
  const originData = isEnvelope ? originResponse.data : originResponse;
  const originRecords = Array.isArray(originData.records) ? originData.records : [];
  const approvedLocalRecords = shouldInjectApprovedRecords(query)
    ? localRecords.map(normalizeRecord).filter(Boolean).filter((item) => String(item.processStatus) === PASS_STATUS)
    : [];
  const mergedRecords = [...approvedLocalRecords, ...originRecords]
    .sort((left, right) => timeValue(right) - timeValue(left));
  const { pageIndex, pageSize } = pageInfo(query);
  const originTotal = Number(originData.total_record ?? originRecords.length);
  const totalRecord = originTotal + approvedLocalRecords.length;
  const totalPage = Math.max(1, Math.ceil(totalRecord / pageSize));
  const start = (pageIndex - 1) * pageSize;
  const pagedRecords = mergedRecords.slice(start, start + pageSize);
  const mergedData = {
    ...originData,
    records: pagedRecords,
    total_record: totalRecord,
    total_page: totalPage,
  };

  if (!isEnvelope) {
    return mergedData;
  }

  return {
    ...originResponse,
    data: mergedData,
  };
}

export function originQueryForMergedPage(query = {}, localRecordCount = 0) {
  if (!shouldInjectApprovedRecords(query) || localRecordCount <= 0) {
    return query;
  }

  const { pageIndex, pageSize } = pageInfo(query);
  const recordsNeededThroughPage = pageIndex * pageSize;
  const originNeeded = Math.max(1, recordsNeededThroughPage - localRecordCount);

  return {
    ...query,
    page_index: 1,
    page_size: originNeeded,
  };
}

export function loadApplications(storagePath) {
  if (!fs.existsSync(storagePath)) {
    return [];
  }

  const raw = fs.readFileSync(storagePath, 'utf8').trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

export function saveApplication(storagePath, payload, userContext = {}) {
  const entry = normalizeApplication(payload, userContext);
  const dir = path.dirname(storagePath);
  fs.mkdirSync(dir, { recursive: true });

  const records = loadApplications(storagePath);
  records.unshift(entry);
  const tempPath = `${storagePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, storagePath);
  return entry;
}

export function recordsFromApplications(applications = [], userContext = {}) {
  return applications.map((entry) => recordForList(hydrateApplicationRecord(entry, userContext).record)).filter(Boolean);
}

export function createLocalOnlyApplyResponse(localRecords, query = {}) {
  return {
    code: 0,
    msg: 'success',
    data: mergeRecords({
      records: [],
      total_record: 0,
      total_page: 1,
    }, localRecords, query),
  };
}
