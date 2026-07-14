// 角色解析測試：resolveRoles_ / isClassTutor_
// 涵蓋：BOOTSTRAP_ADMINS 硬編碼防鎖死、config.users 的 admin/director（含 disabled）、
// 系主任（departments.json headEmail，含 inactive 系所排除）、導師（classes.json tutors，
// 含 inactive 班級排除）、以及一人兼任多角色。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load(['resolveRoles_', 'isClassTutor_'], {
    BOOTSTRAP_ADMINS: ['boot@heartnpust.tw'],
  });
}

test('BOOTSTRAP_ADMINS 硬編碼名單即使 config 完全讀不到也視為 admin', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('boot@heartnpust.tw', null, [], []);
  assert.equal(roles.isAdmin, true);
  assert.equal(roles.isDirector, false);
});

test('config.users role=admin 且未停用 → isAdmin', () => {
  const S = makeSandbox();
  const config = { users: { 'a@x.com': { name: 'A', role: 'admin' } } };
  const roles = S.resolveRoles_('a@x.com', config, [], []);
  assert.equal(roles.isAdmin, true);
});

test('config.users role=admin 但 disabled=true → 不算 admin（也不算任何後台角色）', () => {
  const S = makeSandbox();
  const config = { users: { 'a@x.com': { name: 'A', role: 'admin', disabled: true } } };
  const roles = S.resolveRoles_('a@x.com', config, [], []);
  assert.equal(roles.isAdmin, false);
});

test('config.users role=director 且未停用 → isDirector', () => {
  const S = makeSandbox();
  const config = { users: { 'd@x.com': { name: 'D', role: 'director' } } };
  const roles = S.resolveRoles_('d@x.com', config, [], []);
  assert.equal(roles.isDirector, true);
  assert.equal(roles.isAdmin, false);
});

test('departments.json headEmail 命中且 active → deptHeadOf 含該系所 id；inactive 系所排除', () => {
  const S = makeSandbox();
  const departments = [
    { id: 'dept1', headEmail: 'head@x.com', active: true },
    { id: 'dept2', headEmail: 'head@x.com', active: false },
  ];
  const roles = S.resolveRoles_('head@x.com', {}, departments, []);
  assert.deepEqual(roles.deptHeadOf, ['dept1']);
});

test('classes.json tutors 命中且 active → tutorOf 含該班 id；inactive 班級排除', () => {
  const S = makeSandbox();
  const classes = [
    { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], active: true },
    { id: 'c2', tutors: [{ email: 't@x.com', name: 'T' }], active: false },
    { id: 'c3', tutors: [{ email: 'other@x.com', name: 'O' }], active: true },
  ];
  const roles = S.resolveRoles_('t@x.com', {}, [], classes);
  assert.deepEqual(roles.tutorOf, ['c1']);
});

test('雙導師班：兩位 tutors 都能各自解析出 tutorOf', () => {
  const S = makeSandbox();
  const classes = [{ id: 'c1', tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }], active: true }];
  assert.deepEqual(S.resolveRoles_('t1@x.com', {}, [], classes).tutorOf, ['c1']);
  assert.deepEqual(S.resolveRoles_('t2@x.com', {}, [], classes).tutorOf, ['c1']);
});

test('一人可兼任多角色：同時是系主任與某班導師', () => {
  const S = makeSandbox();
  const departments = [{ id: 'dept1', headEmail: 'x@x.com', active: true }];
  const classes = [{ id: 'c1', tutors: [{ email: 'x@x.com', name: 'X' }], active: true }];
  const roles = S.resolveRoles_('x@x.com', {}, departments, classes);
  assert.deepEqual(roles.deptHeadOf, ['dept1']);
  assert.deepEqual(roles.tutorOf, ['c1']);
});

test('未登入（email 空字串/undefined）一律回傳全 false 的角色', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('', {}, [], []);
  assert.equal(roles.isAdmin, false);
  assert.equal(roles.isDirector, false);
  assert.deepEqual(roles.deptHeadOf, []);
  assert.deepEqual(roles.tutorOf, []);
});

test('isClassTutor_：命中/未命中/classInfo 為 null', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }] };
  assert.equal(S.isClassTutor_(classInfo, 't@x.com'), true);
  assert.equal(S.isClassTutor_(classInfo, 'other@x.com'), false);
  assert.equal(S.isClassTutor_(null, 't@x.com'), false);
});

// ── staffLead / staffAssistant（第二期新增角色）──────────────────────────────

test('config.staffLeads 命中且未停用 → isStaffLead；停用則不算', () => {
  const S = makeSandbox();
  const config = { staffLeads: [{ email: 'lead@x.com', name: 'Lead' }, { email: 'old@x.com', name: 'Old', disabled: true }] };
  assert.equal(S.resolveRoles_('lead@x.com', config, [], []).isStaffLead, true);
  assert.equal(S.resolveRoles_('old@x.com', config, [], []).isStaffLead, false);
});

test('config.staffAssistants 命中且未停用 → isStaffAssistant，assistantLead 綁定對應的未停用主責', () => {
  const S = makeSandbox();
  const config = {
    staffLeads: [{ email: 'lead@x.com', name: 'Lead' }],
    staffAssistants: [{ email: 'assist@x.com', name: 'Assist', leadEmail: 'lead@x.com' }],
  };
  const roles = S.resolveRoles_('assist@x.com', config, [], []);
  assert.equal(roles.isStaffAssistant, true);
  assert.deepEqual(roles.assistantLead, { email: 'lead@x.com', name: 'Lead' });
});

test('assistantLead fail-closed：綁定的主責不存在或已停用 → assistantLead 為 null（無法代為核章）', () => {
  const S = makeSandbox();
  const configMissing = {
    staffLeads: [],
    staffAssistants: [{ email: 'assist@x.com', name: 'Assist', leadEmail: 'ghost@x.com' }],
  };
  assert.equal(S.resolveRoles_('assist@x.com', configMissing, [], []).assistantLead, null);

  const configDisabledLead = {
    staffLeads: [{ email: 'lead@x.com', name: 'Lead', disabled: true }],
    staffAssistants: [{ email: 'assist@x.com', name: 'Assist', leadEmail: 'lead@x.com' }],
  };
  assert.equal(S.resolveRoles_('assist@x.com', configDisabledLead, [], []).assistantLead, null);
});

test('停用的助理帳號 → isStaffAssistant 為 false，assistantLead 也不算', () => {
  const S = makeSandbox();
  const config = {
    staffLeads: [{ email: 'lead@x.com', name: 'Lead' }],
    staffAssistants: [{ email: 'assist@x.com', name: 'Assist', leadEmail: 'lead@x.com', disabled: true }],
  };
  const roles = S.resolveRoles_('assist@x.com', config, [], []);
  assert.equal(roles.isStaffAssistant, false);
  assert.equal(roles.assistantLead, null);
});

// ── 軟刪除（deleted:true）：Ticket B ─────────────────────────────────────────

test('已刪除系所（active 仍為 true）headEmail 命中 → 不賦予 deptHead 角色', () => {
  const S = makeSandbox();
  const departments = [{ id: 'dept1', headEmail: 'head@x.com', active: true, deleted: true }];
  const roles = S.resolveRoles_('head@x.com', {}, departments, []);
  assert.deepEqual(roles.deptHeadOf, []);
});

test('config.users role=admin/director 但 deleted=true（disabled 仍為未停用）→ 不算任何後台角色', () => {
  const S = makeSandbox();
  const config = { users: { 'a@x.com': { name: 'A', role: 'admin', disabled: false, deleted: true } } };
  const roles = S.resolveRoles_('a@x.com', config, [], []);
  assert.equal(roles.isAdmin, false);
  assert.equal(roles.isDirector, false);
});

test('config.staffLeads 命中但 deleted=true（disabled 仍為未停用）→ 不算 isStaffLead', () => {
  const S = makeSandbox();
  const config = { staffLeads: [{ email: 'lead@x.com', name: 'Lead', disabled: false, deleted: true }] };
  assert.equal(S.resolveRoles_('lead@x.com', config, [], []).isStaffLead, false);
});

test('config.staffAssistants 命中但 deleted=true → 不算 isStaffAssistant，assistantLead 也不算', () => {
  const S = makeSandbox();
  const config = {
    staffLeads: [{ email: 'lead@x.com', name: 'Lead' }],
    staffAssistants: [{ email: 'assist@x.com', name: 'Assist', leadEmail: 'lead@x.com', deleted: true }],
  };
  const roles = S.resolveRoles_('assist@x.com', config, [], []);
  assert.equal(roles.isStaffAssistant, false);
  assert.equal(roles.assistantLead, null);
});

test('assistantLead fail-closed：綁定的主責 deleted=true（disabled 仍為未停用）→ assistantLead 為 null', () => {
  const S = makeSandbox();
  const config = {
    staffLeads: [{ email: 'lead@x.com', name: 'Lead', disabled: false, deleted: true }],
    staffAssistants: [{ email: 'assist@x.com', name: 'Assist', leadEmail: 'lead@x.com' }],
  };
  const roles = S.resolveRoles_('assist@x.com', config, [], []);
  assert.equal(roles.isStaffAssistant, true);
  assert.equal(roles.assistantLead, null);
});

test('一人可同時兼任導師 + 系主任 + staffLead（並集不互斥）', () => {
  const S = makeSandbox();
  const config = { staffLeads: [{ email: 'x@x.com', name: 'X' }] };
  const departments = [{ id: 'dept1', headEmail: 'x@x.com', active: true }];
  const classes = [{ id: 'c1', tutors: [{ email: 'x@x.com', name: 'X' }], active: true }];
  const roles = S.resolveRoles_('x@x.com', config, departments, classes);
  assert.equal(roles.isStaffLead, true);
  assert.deepEqual(roles.deptHeadOf, ['dept1']);
  assert.deepEqual(roles.tutorOf, ['c1']);
});
