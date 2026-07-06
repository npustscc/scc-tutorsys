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
