import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildLocalFlowRecord,
  buildLocalSubmitInfo,
  buildLocalWorkflowStatus,
  approvalDelaySeconds,
  deriveUserContextFromOriginRecords,
  deriveWorkflowTemplateFromOriginFlow,
  hydrateApplicationRecord,
  localApprovalTime,
  loadApplications,
  mergeRecords,
  normalizeApplication,
  originQueryForMergedPage,
  recordsFromApplications,
  saveApplication,
  selectApplicationsForUser,
} from './backend-records.mjs';

const samplePayload = {
  formId: '100017',
  businessNo: 'BM5017',
  subClient: 'apph5_internal_student',
  formVersion: '1',
  params: {
    name: '张三',
    userNo: '20260001',
    className: '软件一班',
    gatewayTransitBeginTime: '2026-06-11 09:00:00',
    gatewayTransitEndTime: '2026-06-11 18:00:00',
    gatewayTransitReason: '事假',
    applyMove: '出校',
    gatewayTransitDesc: '本地测试申请',
  },
};

const realTransitPayload = {
  formId: '100017',
  businessNo: 'BM5017',
  subClient: 'apph5_internal_student',
  params: {
    flowRecords: [],
    gatewayTransitBeginTime: '2026-06-11 19:15:57',
    gatewayTransitEndTime: '2026-06-11 23:59:59',
    approvalTrendId: ['3'],
    gatewayTransitType: '7',
    shiyoumiaoshu: '12314',
    benrenchengnuo: ['1'],
  },
  formVersion: 1,
};

const otherTransitPayload = {
  ...realTransitPayload,
  params: {
    ...realTransitPayload.params,
    gatewayTransitType: '8',
    shiyoumiaoshu: '选择其他原因',
  },
};

const userContext = {
  name: '测试用户',
  studentNo: 'TEST-0001',
  className: '测试班级',
  formName: '出入申请',
};

function labels(record) {
  return new Map(record.paramList.map((item) => [item.label, item.value]));
}

function detailLabels(submitInfo) {
  return new Map(
    submitInfo.itemList
      .flatMap((panel) => panel.children || [])
      .flatMap((item) => item.children || [item])
      .map((item) => [item.itemName, submitInfo.submit[item.itemField]]),
  );
}

function record(title1, id) {
  return {
    title1,
    title2: `原站记录 ${id}`,
    processStatus: '2',
    submitId: `origin-${id}`,
    processId: `origin-process-${id}`,
    taskId: `origin-task-${id}`,
    paramList: [],
  };
}

{
  const normalized = normalizeApplication(samplePayload, {
    now: new Date('2026-06-11T10:20:30+08:00'),
  });

  assert.equal(normalized.status, 'approved');
  assert.equal(normalized.record.processStatus, '2');
  assert.equal(normalized.record.title1, '2026-06-11 10:20:30');
  assert.equal(normalized.record.title2, '张三 发起的申请');
  assert.equal(normalized.record.submitId, normalized.record.processId);
  assert.ok(normalized.record.submitId.startsWith('local-'));

  const paramLabels = labels(normalized.record);
  assert.equal(paramLabels.get('表单'), '出入申请');
  assert.equal(paramLabels.get('学号'), '20260001');
  assert.equal(paramLabels.get('班级'), '软件一班');
  assert.equal(paramLabels.get('开始时间'), '2026-06-11 09:00:00');
  assert.equal(paramLabels.get('结束时间'), '2026-06-11 18:00:00');
  assert.equal(paramLabels.get('进出事由'), '事假');
  assert.equal(paramLabels.get('申请动向'), '出校');
  assert.equal(paramLabels.get('事由描述'), '本地测试申请');
}

{
  const originContext = deriveUserContextFromOriginRecords({
    data: {
      records: [{
        title2: '测试用户 发起的申请',
        paramList: [
          { label: '表单', value: '出入申请' },
          { label: '学号', value: 'TEST-0001' },
          { label: '班级', value: '测试班级' },
          { label: '进出事由', value: '事假' },
        ],
      }],
    },
  });

  assert.deepEqual(originContext, userContext);
}

{
  const normalized = normalizeApplication(realTransitPayload, {
    ...userContext,
    now: new Date('2026-06-11T19:16:03+08:00'),
  });

  assert.equal(normalized.record.title2, '测试用户 发起的申请');
  const paramLabels = labels(normalized.record);
  assert.equal(paramLabels.get('表单'), '出入申请');
  assert.equal(paramLabels.get('学号'), 'TEST-0001');
  assert.equal(paramLabels.get('班级'), '测试班级');
  assert.equal(paramLabels.get('开始时间'), '2026-06-11 19:15:57');
  assert.equal(paramLabels.get('结束时间'), '2026-06-11 23:59:59');
  assert.equal(paramLabels.get('进出事由'), '事假');
  assert.equal(paramLabels.get('申请动向'), '申请宿舍免查寝');
  assert.equal(paramLabels.get('事由描述'), '12314');
}

{
  const normalized = normalizeApplication(otherTransitPayload, {
    ...userContext,
    now: new Date('2026-06-11T19:16:03+08:00'),
  });
  const paramLabels = labels(normalized.record);
  assert.equal(paramLabels.get('进出事由'), '其他');

  const [recordFromEntry] = recordsFromApplications([normalized], userContext);
  const recordLabels = labels(recordFromEntry);
  assert.equal(recordLabels.get('进出事由'), '其他');

  const submitInfo = buildLocalSubmitInfo(normalized, userContext);
  const detailValues = detailLabels(submitInfo);
  assert.equal(detailValues.get('进出事由'), '其他');
  assert.equal(detailValues.get('事由描述'), '选择其他原因');
}

{
  const oldEntry = normalizeApplication(realTransitPayload, {
    now: new Date('2026-06-11T19:16:03+08:00'),
  });
  assert.equal(labels(oldEntry.record).get('学号'), '--');

  const hydrated = hydrateApplicationRecord(oldEntry, userContext);
  assert.equal(hydrated.id, oldEntry.id);
  assert.equal(hydrated.record.submitId, oldEntry.id);
  assert.equal(hydrated.record.title1, oldEntry.record.title1);
  assert.equal(hydrated.record.title2, '测试用户 发起的申请');

  const paramLabels = labels(hydrated.record);
  assert.equal(paramLabels.get('学号'), 'TEST-0001');
  assert.equal(paramLabels.get('班级'), '测试班级');
  assert.equal(paramLabels.get('进出事由'), '事假');
  assert.equal(paramLabels.get('申请动向'), '申请宿舍免查寝');
  assert.equal(paramLabels.get('事由描述'), '12314');

  const [recordFromEntry] = recordsFromApplications([oldEntry], userContext);
  const recordLabels = labels(recordFromEntry);
  assert.equal(recordLabels.get('学号'), 'TEST-0001');
  assert.equal(recordLabels.get('班级'), '测试班级');
  assert.equal(recordLabels.has('事由描述'), false);
}

{
  const sameAccountLegacy = normalizeApplication(realTransitPayload, {
    clientKey: 'old-session',
    now: new Date('2026-06-11T19:16:03+08:00'),
  });
  const sameAccountStable = normalizeApplication(realTransitPayload, {
    ...userContext,
    clientKey: 'stable-session',
    now: new Date('2026-06-11T19:17:03+08:00'),
  });
  const otherAccountLegacy = normalizeApplication(realTransitPayload, {
    clientKey: 'other-old-session',
    now: new Date('2026-06-11T19:18:03+08:00'),
  });
  const otherAccountStable = normalizeApplication(realTransitPayload, {
    userKey: 'TEST-0002',
    clientKey: 'other-stable-session',
    now: new Date('2026-06-11T19:19:03+08:00'),
  });

  const scoped = selectApplicationsForUser([
    sameAccountLegacy,
    sameAccountStable,
    otherAccountLegacy,
    otherAccountStable,
  ], {
    ...userContext,
    clientKey: 'new-session-after-logout',
  }, {
    'old-session': userContext,
    'other-old-session': {
      name: '鍗曟櫀',
      studentNo: 'TEST-0002',
      className: userContext.className,
      formName: userContext.formName,
    },
    'other-stable-session': {
      name: '鍗曟櫀',
      studentNo: 'TEST-0002',
      className: userContext.className,
      formName: userContext.formName,
    },
  });

  assert.deepEqual(scoped.map((entry) => entry.id), [sameAccountLegacy.id, sameAccountStable.id]);
}

{
  const unownedLegacyEntry = {
    id: 'local-unowned',
    clientKey: '',
    userKey: '',
    payload: {},
    record: {},
  };
  assert.deepEqual(
    selectApplicationsForUser([unownedLegacyEntry], { ...userContext, clientKey: 'new-session' }, {}),
    [],
    'unowned legacy records must not be exposed to an authenticated user',
  );
}

{
  const entry = normalizeApplication(realTransitPayload, {
    ...userContext,
    now: new Date('2026-06-11T19:16:03+08:00'),
  });
  const submitInfo = buildLocalSubmitInfo(entry, userContext);
  const panelNames = submitInfo.itemList.map((panel) => panel.itemName);
  const detailValues = detailLabels(submitInfo);

  assert.equal(submitInfo.submit.processStatus, '2');
  assert.deepEqual(panelNames, ['申请人信息', '申请时间', '申请理由']);
  assert.equal(detailValues.get('姓名'), '测试用户');
  assert.equal(detailValues.get('学号'), 'TEST-0001');
  assert.equal(detailValues.get('学院'), '数字商贸学院-高职');
  assert.equal(detailValues.get('专业'), '测试班级');
  assert.equal(detailValues.get('班级'), '测试班级');
  assert.equal(detailValues.get('开始时间'), '2026-06-11 19:15:57');
  assert.equal(detailValues.get('结束时间'), '2026-06-11 23:59:59');
  assert.equal(detailValues.get('进出事由'), '事假');
  assert.equal(detailValues.get('申请动向'), '申请宿舍免查寝');
  assert.equal(detailValues.get('事由描述'), '12314');

  const flowRecord = buildLocalFlowRecord(entry, userContext);
  assert.equal(flowRecord.processStatus, '2');
  assert.equal(flowRecord.submitId, entry.id);
  assert.deepEqual(flowRecord.actList.map((node) => node.actName), ['班主任', '抄送通知']);
  const teacherNode = flowRecord.actList[0];
  assert.equal(teacherNode.actTypeId, 1);
  assert.equal(teacherNode.multiTypeId, 2);
  assert.equal(teacherNode.isFinish, 1);
  assert.equal(teacherNode.handleType, 1);
  assert.equal(teacherNode.taskList.length, 2);
  const approvedTeachers = teacherNode.taskList.filter((task) => task.handleType === 1);
  const pendingTeachers = teacherNode.taskList.filter((task) => task.handleType === 0);
  assert.equal(approvedTeachers.length, 1);
  assert.equal(pendingTeachers.length, 1);
  assert.ok(['王彤彤', '赵志慧'].includes(approvedTeachers[0].handleUserName));
  assert.equal(approvedTeachers[0].handleRemark, '同意');
  assert.equal(approvalDelaySeconds(entry), approvalDelaySeconds(entry));
  assert.ok(approvalDelaySeconds(entry) >= 10 && approvalDelaySeconds(entry) <= 30);
  assert.equal(
    approvedTeachers[0].handleTime,
    localApprovalTime(entry),
  );
  assert.match(approvedTeachers[0].handleTime, /^2026-06-11 19:16:(1[3-9]|2\d|3[0-3])$/u);
  assert.equal(buildLocalFlowRecord(entry, userContext).actList[0].taskList[0].handleUserName, teacherNode.taskList[0].handleUserName);
  const copyNode = flowRecord.actList[1];
  assert.equal(copyNode.actTypeId, 2);
  assert.deepEqual(copyNode.taskList.map((task) => task.handleUserName), ['杨保福', '杨振辉']);
  assert.ok(copyNode.taskList.every((task) => task.handleType === 4));

  assert.deepEqual(buildLocalWorkflowStatus(), {
    cancel: false,
    approval: false,
    transfer: false,
  });
}

{
  const entry = normalizeApplication(realTransitPayload, {
    ...userContext,
    now: new Date('2026-06-11T19:16:03+08:00'),
  });
  const template = deriveWorkflowTemplateFromOriginFlow({
    data: {
      actList: [
        {
          actId: 'origin-teacher',
          actName: '班主任',
          actTypeId: 1,
          multiTypeId: 2,
          isFinish: 1,
          handleType: 1,
          taskList: [{
            taskId: 'origin-teacher-task',
            handleUserName: '测试班主任',
            handleTime: '2026-06-10 08:30:00',
            handleRemark: '同意',
            handleType: 1,
            isHandleDev: 0,
          }],
        },
        {
          actId: 'origin-copy',
          actName: '抄送通知',
          actTypeId: 2,
          multiTypeId: 1,
          isFinish: 1,
          handleType: 4,
          taskList: [{
            taskId: 'origin-copy-task',
            handleUserName: '测试抄送人',
            handleTime: '2026-06-10 08:30:00',
            handleRemark: '',
            handleType: 4,
            isHandleDev: 0,
          }],
        },
      ],
    },
  });

  assert.ok(template);
  const flowRecord = buildLocalFlowRecord(entry, {
    ...userContext,
    workflowTemplate: template,
  });
  assert.deepEqual(flowRecord.actList.map((node) => node.actName), ['班主任', '抄送通知']);
  assert.deepEqual(flowRecord.actList[0].taskList.map((task) => task.handleUserName), ['测试班主任']);
  assert.deepEqual(flowRecord.actList[1].taskList.map((task) => task.handleUserName), ['测试抄送人']);
  assert.equal(flowRecord.actList[0].taskList[0].handleRemark, '同意');
  assert.equal(flowRecord.actList[0].taskList[0].handleTime, localApprovalTime(entry));
  assert.equal(flowRecord.actList[0].actId, `${entry.id}-origin-act-1`);
  assert.equal(flowRecord.actList[0].taskList[0].taskId, `${entry.id}-origin-act-1-task-1`);
}

{
  const localNewest = normalizeApplication(samplePayload, {
    now: new Date('2026-06-11T10:20:30+08:00'),
  }).record;
  const localOlder = normalizeApplication({
    ...samplePayload,
    params: {
      ...samplePayload.params,
      gatewayTransitDesc: '更早的本地测试申请',
    },
  }, {
    now: new Date('2026-06-10T08:00:00+08:00'),
  }).record;

  const originResponse = {
    records: [
      record('2026-06-09 12:00:00', 'a'),
      record('2026-06-08 12:00:00', 'b'),
    ],
    total_record: 2,
    total_page: 1,
    exData: { untouched: true },
  };
  const query = {
    page_index: 1,
    page_size: 2,
    search: {
      processStatusList: ['2'],
    },
  };

  const merged = mergeRecords(originResponse, [localOlder, localNewest], query);
  assert.deepEqual(
    merged.records.map((item) => item.title1),
    ['2026-06-11 10:20:30', '2026-06-10 08:00:00'],
  );
  assert.equal(merged.total_record, 4);
  assert.equal(merged.total_page, 2);
  assert.deepEqual(merged.exData, { untouched: true });

  const secondPage = mergeRecords(originResponse, [localOlder, localNewest], {
    ...query,
    page_index: 2,
  });
  assert.deepEqual(
    secondPage.records.map((item) => item.title1),
    ['2026-06-09 12:00:00', '2026-06-08 12:00:00'],
  );
}

{
  const local = normalizeApplication(samplePayload, {
    now: new Date('2026-06-11T10:20:30+08:00'),
  }).record;
  const originResponse = {
    records: [record('2026-06-09 12:00:00', 'a')],
    total_record: 1,
    total_page: 1,
  };

  const merged = mergeRecords(originResponse, [local], {
    page_index: 1,
    page_size: 10,
    search: {
      processStatusList: [1],
    },
  });

  assert.deepEqual(merged.records.map((item) => item.submitId), ['origin-a']);
  assert.equal(merged.total_record, 1);
}

{
  const originResponse = {
    records: [record('2026-06-09 12:00:00', 'a')],
    total_record: 100,
    total_page: 10,
  };
  const mergedWithoutLocal = mergeRecords(originResponse, [], {
    page_index: 1,
    page_size: 10,
    search: {
      processStatusList: [1],
    },
  });
  assert.equal(mergedWithoutLocal.total_record, 100);
  assert.equal(mergedWithoutLocal.total_page, 10);

  const local = normalizeApplication(samplePayload, {
    now: new Date('2026-06-11T10:20:30+08:00'),
  }).record;
  const mergedWithLocal = mergeRecords(originResponse, [local], {
    page_index: 1,
    page_size: 10,
    search: {
      processStatusList: [2],
    },
  });
  assert.equal(mergedWithLocal.total_record, 101);
  assert.equal(mergedWithLocal.total_page, 11);
}

{
  const adjusted = originQueryForMergedPage({
    page_index: 2,
    page_size: 10,
    search: {
      processStatusList: ['2'],
    },
  }, 1);
  assert.equal(adjusted.page_index, 1);
  assert.equal(adjusted.page_size, 19);

  const unchanged = originQueryForMergedPage({
    page_index: 2,
    page_size: 10,
    search: {
      processStatusList: [1],
    },
  }, 1);
  assert.equal(unchanged.page_index, 2);
  assert.equal(unchanged.page_size, 10);

  const coveredByLocal = originQueryForMergedPage({
    page_index: 1,
    page_size: 10,
    search: {
      processStatusList: [2],
    },
  }, 12);
  assert.equal(coveredByLocal.page_index, 1);
  assert.equal(coveredByLocal.page_size, 1);
}

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-local-backend-'));
  const storagePath = path.join(tempDir, 'applications.json');
  const saved = saveApplication(storagePath, samplePayload, {
    now: new Date('2026-06-11T10:20:30+08:00'),
  });
  const loaded = loadApplications(storagePath);

  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], saved);
  assert.equal(loaded[0].record.processStatus, '2');
  assert.deepEqual(loaded[0].payload, samplePayload);
}

console.log('Local backend tests passed.');
