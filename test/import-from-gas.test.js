// importer 合併策略的測試（server/scripts/import-from-gas.mjs 的純函式部分）。
//
// 這裡測的核心是一句話：**收集端是名冊的權威，校內端是紀錄的權威**。
// 所以合併只能覆蓋名冊欄位，本地那些「投影裡沒有」的欄位一個都不能掉——
// deptRosterGet 是投影，整筆覆寫會把 uploadWhitelist/suggestedTutors/nameHistory 清空，
// 紀錄與核章的關聯也會跟著壞。

const test = require('node:test');
const assert = require('node:assert');

let mergeClasses, mergeDepartments;
test.before(async () => {
  const mod = await import('../server/scripts/import-from-gas.mjs');
  mergeClasses = mod.mergeClasses;
  mergeDepartments = mod.mergeDepartments;
});

function localClass(over) {
  return Object.assign({
    id: '農園系_四技一A', name: '四技一A', deptId: '農園系', systemId: 'day_college',
    displayName: '四農園一A', requiredMeetingOverride: 4, graduatedSemester: null, active: true,
    tutors: [{ name: '李鎮宇', email: '' }],
    suggestedTutors: [{ name: '學生填的' }], uploadWhitelist: ['s@gmail.com'],
    dualApprovalMode: 'all', nameHistory: [{ upToSemester: '114-1', name: '四技零A' }],
    createdAt: '2026-07-01T00:00:00Z',
  }, over || {});
}

test('🔒 更新既有班級時，投影裡沒有的本地欄位一律保留', () => {
  const local = [localClass()];
  const remote = [{
    id: '農園系_四技一A', name: '四技一A', deptId: '農園系', systemId: 'day_college',
    displayName: '四農園一A', requiredMeetingOverride: 4, graduatedSemester: null, active: true,
    tutors: [{ name: '李鎮宇', email: 'lee@x.com', ext: '7140', mobile: '0912345678' }],
  }];
  const { classes } = mergeClasses(local, remote);
  const c = classes[0];
  assert.deepEqual(c.suggestedTutors, [{ name: '學生填的' }]);
  assert.deepEqual(c.uploadWhitelist, ['s@gmail.com']);
  assert.equal(c.dualApprovalMode, 'all');
  assert.equal(c.nameHistory.length, 1);
  assert.equal(c.createdAt, '2026-07-01T00:00:00Z');
  // 名冊欄位要被覆蓋：分機與手機進來了
  assert.deepEqual(c.tutors, [{ name: '李鎮宇', email: 'lee@x.com', ext: '7140', mobile: '0912345678' }]);
});

test('名冊欄位（班名/簡稱/應繳/畢業/停用）以收集端為準', () => {
  const remote = [{
    id: '農園系_四技一A', name: '四技二A', displayName: '四農園二A', deptId: '農園系',
    systemId: 'day_college', requiredMeetingOverride: 0, graduatedSemester: '115-1', active: false,
    tutors: [],
  }];
  const { classes } = mergeClasses([localClass()], remote);
  const c = classes[0];
  assert.equal(c.name, '四技二A');
  assert.equal(c.displayName, '四農園二A');
  assert.equal(c.requiredMeetingOverride, 0);
  assert.equal(c.graduatedSemester, '115-1');
  assert.equal(c.active, false);
  assert.deepEqual(c.tutors, []);
});

test('收集端有、本地沒有 → 新增，並帶上本地欄位的合理預設值', () => {
  const remote = [{ id: '森林系_家族陳美惠', name: '家族陳美惠', deptId: '森林系', displayName: '森林陳美惠家族', tutors: [{ name: '陳美惠', mobile: '0911' }] }];
  const { classes, report } = mergeClasses([], remote);
  assert.deepEqual(report.created, ['森林系_家族陳美惠']);
  const c = classes[0];
  assert.deepEqual(c.suggestedTutors, []);
  assert.deepEqual(c.uploadWhitelist, []);
  assert.equal(c.dualApprovalMode, 'any');
  assert.equal(c.active, true);
  assert.deepEqual(c.tutors, [{ name: '陳美惠', email: '', ext: '', mobile: '0911' }]);
});

test('🔒 本地有、收集端沒有 → 絕不刪除，只列進報告', () => {
  const local = [localClass(), localClass({ id: '農園系_碩二', name: '碩二' })];
  const remote = [{ id: '農園系_四技一A', name: '四技一A', deptId: '農園系', tutors: [] }];
  const { classes, report } = mergeClasses(local, remote);
  assert.equal(classes.length, 2, '本地班級不得消失');
  assert.deepEqual(report.localOnly, ['農園系_碩二']);
});

test('內容相同時歸類為無變動（避免每次同步都報一堆假異動）', () => {
  const local = [localClass({ tutors: [{ name: '李鎮宇', email: 'a@x.com', ext: '', mobile: '0911' }] })];
  const remote = [{
    id: '農園系_四技一A', name: '四技一A', deptId: '農園系', systemId: 'day_college',
    displayName: '四農園一A', requiredMeetingOverride: 4, graduatedSemester: null, active: true,
    tutors: [{ name: '李鎮宇', email: 'a@x.com', ext: '', mobile: '0911' }],
  }];
  const { report } = mergeClasses(local, remote);
  assert.deepEqual(report.unchanged, ['農園系_四技一A']);
  assert.deepEqual(report.updated, []);
});

test('系所：新增與改名，且不動 headEmail 等本地欄位', () => {
  const local = [{ id: '農園系', name: '農園系', collegeId: '農學院', headEmail: 'head@x.com', headName: '系主任', active: true }];
  const remote = [{ id: '農園系', name: '農藝系', collegeId: '農學院' }, { id: '森林系', name: '森林系', collegeId: '農學院' }];
  const { departments, report } = mergeDepartments(local, remote);
  assert.deepEqual(report.updated, ['農園系']);
  assert.deepEqual(report.created, ['森林系']);
  assert.equal(departments[0].name, '農藝系');
  assert.equal(departments[0].headEmail, 'head@x.com', '系主任 email 是本地資料，不該被投影蓋掉');
});

test('欄位形狀差異不算變動：本地 tutors 沒有聯絡欄位、graduatedSemester 是 undefined', () => {
  // 首次預演時 375 筆全被報成「更新」，實際上只是本地舊資料還沒有那些欄位。
  const local = [localClass({ tutors: [{ name: '李鎮宇', email: '' }], graduatedSemester: undefined })];
  delete local[0].graduatedSemester;
  const remote = [{
    id: '農園系_四技一A', name: '四技一A', deptId: '農園系', systemId: 'day_college',
    displayName: '四農園一A', requiredMeetingOverride: 4, graduatedSemester: null, active: true,
    tutors: [{ name: '李鎮宇', email: '', ext: '', mobile: '' }],
  }];
  const { classes, report } = mergeClasses(local, remote);
  assert.deepEqual(report.unchanged, ['農園系_四技一A'], '形狀差異不該算成變動');
  assert.deepEqual(report.updated, []);
  // 仍然要把正規化後的形狀寫回去（之後就有 ext/mobile 欄位了）
  assert.deepEqual(classes[0].tutors, [{ name: '李鎮宇', email: '', ext: '', mobile: '' }]);
});

test('真的有手機填進來時，要算成變動', () => {
  const local = [localClass({ tutors: [{ name: '李鎮宇', email: '' }] })];
  const remote = [{ id: '農園系_四技一A', name: '四技一A', deptId: '農園系', systemId: 'day_college',
    displayName: '四農園一A', requiredMeetingOverride: 4, graduatedSemester: null, active: true,
    tutors: [{ name: '李鎮宇', email: '', mobile: '0912345678' }] }];
  const { report } = mergeClasses(local, remote);
  assert.deepEqual(report.updated, ['農園系_四技一A']);
});

test('換版相容：本地是舊的 phone、遠端已改用 mobile → 同一支號碼不算變動', () => {
  // 2026-08-11 拆成 ext/mobile。兩軌的資料是分開的，收集端（GAS）先換版、自架端的
  // classes.json 還留著 phone——不折進 mobile 比較的話，換版後第一次同步會整批報成「更新」。
  const local = [localClass({ tutors: [{ name: '李鎮宇', email: 'a@x.com', phone: '0911' }] })];
  const remote = [{
    id: '農園系_四技一A', name: '四技一A', deptId: '農園系', systemId: 'day_college',
    displayName: '四農園一A', requiredMeetingOverride: 4, graduatedSemester: null, active: true,
    tutors: [{ name: '李鎮宇', email: 'a@x.com', ext: '', mobile: '0911' }],
  }];
  const { classes, report } = mergeClasses(local, remote);
  assert.deepEqual(report.unchanged, ['農園系_四技一A']);
  // 寫回去的是新形狀，舊鍵不留著
  assert.deepEqual(classes[0].tutors, [{ name: '李鎮宇', email: 'a@x.com', ext: '', mobile: '0911' }]);
});

test('系所：正式全名（fullName）也要同步過來，其餘本地欄位不動', () => {
  const local = [{ id: '農園系', name: '農園系', collegeId: '農學院', headEmail: 'head@x.com', headName: '系主任', active: true }];
  const remote = [{ id: '農園系', name: '農園系', fullName: '農園生產系', collegeId: '農學院' }];
  const { departments, report } = mergeDepartments(local, remote);
  assert.deepEqual(report.updated, ['農園系']);
  assert.equal(departments[0].fullName, '農園生產系');
  assert.equal(departments[0].name, '農園系', '內部簡稱名不該被全名蓋掉');
  assert.equal(departments[0].headEmail, 'head@x.com');
  // 再跑一次不該再報變動
  assert.deepEqual(mergeDepartments(departments, remote).report.updated, []);
});
