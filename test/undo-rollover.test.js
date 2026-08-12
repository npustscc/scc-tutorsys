// test/undo-rollover.test.js — 復原 2026-08-11 那次部分套用的 rollover（dev/Code.gs 版）。
//
// 這是**對正式資料寫入**的維護函式，錯了的代價是把 376 個班改壞，所以測的重點不是
// 「有沒有復原」，而是「有沒有多做」：本來就停用的班不可以被救活、別的學期的升級不可以
// 被牽連、沒有痕跡的資料要一個字都不動。
//
// 最後一條是往返：模擬 2026-08-11 那次事故實際落地的寫入形狀（當時的 cohort 式 rollover——
// advance 改名／graduate 停用；rollover 本身已在同一批修改中改為席位式，不再有這兩個動作，
// 這裡刻意保留歷史形狀只是為了驗證復原函式，不代表 computeRolloverPlan_/adminRolloverApply
// 現在還會產生這種寫入），再復原，結果要與原檔逐位元一致。

const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

const S = load(['undoRolloverInPlace_', 'undoRolloverSummary_']);

const FROM = '114-2';

function cls(o) {
  return Object.assign({ id: 'c1', deptId: '森林系', name: '四技四', displayName: '四森林四', active: true, graduatedSemester: null }, o);
}

test('graduate 的班：graduatedSemester 還原成 null（不是刪欄位）、active 改回 true', () => {
  const list = [cls({ id: 'a', active: false, graduatedSemester: FROM })];
  const plan = S.undoRolloverInPlace_(list, FROM);
  assert.equal(plan.unGraduated.length, 1);
  assert.strictEqual(list[0].graduatedSemester, null);
  assert.ok('graduatedSemester' in list[0], '欄位不可以被 delete：importer 的比對會把 undefined 當成有更新');
  assert.strictEqual(list[0].active, true);
});

test('本來就停用、沒有畢業註記的班 → 一個字都不動（不會被誤救活）', () => {
  const list = [cls({ id: 'b', active: false, graduatedSemester: null })];
  const before = JSON.stringify(list);
  const plan = S.undoRolloverInPlace_(list, FROM);
  assert.equal(plan.unGraduated.length, 0);
  assert.equal(JSON.stringify(list), before);
});

test('別的學期畢業的班不受牽連', () => {
  const list = [cls({ id: 'c', active: false, graduatedSemester: '113-2' })];
  const before = JSON.stringify(list);
  S.undoRolloverInPlace_(list, FROM);
  assert.equal(JSON.stringify(list), before);
});

test('advance 的班：還原 name/displayName，並把 nameHistory 最後一筆 pop 掉', () => {
  const list = [cls({
    id: 'd', name: '產專二', displayName: '動畜產專二',
    nameHistory: [{ name: '產專一', displayName: '動畜產專一', upToSemester: FROM }],
  })];
  const plan = S.undoRolloverInPlace_(list, FROM);
  assert.equal(plan.renamed.length, 1);
  assert.equal(list[0].name, '產專一');
  assert.equal(list[0].displayName, '動畜產專一');
  assert.ok(!('nameHistory' in list[0]), 'pop 完空了就該回到原本沒有這個欄位的樣子');
});

test('nameHistory 還有更早的紀錄 → 只 pop 最後一筆，欄位保留', () => {
  const list = [cls({
    id: 'e', name: '四技三',
    nameHistory: [
      { name: '四技一', upToSemester: '113-2' },
      { name: '四技二', upToSemester: FROM },
    ],
  })];
  S.undoRolloverInPlace_(list, FROM);
  assert.equal(list[0].name, '四技二');
  assert.equal(list[0].nameHistory.length, 1);
  assert.equal(list[0].nameHistory[0].upToSemester, '113-2');
});

test('nameHistory 最後一筆是別的學期 → 不動（只認最後一筆，不往前翻）', () => {
  const list = [cls({
    id: 'f', name: '四技三',
    nameHistory: [{ name: '四技二', upToSemester: FROM }, { name: '四技三', upToSemester: '115-1' }],
  })];
  const before = JSON.stringify(list);
  S.undoRolloverInPlace_(list, FROM);
  assert.equal(JSON.stringify(list), before);
});

test('同一班同時被 graduate 又被 advance → 兩件事都復原', () => {
  const list = [cls({
    id: 'g', name: '碩二', active: false, graduatedSemester: FROM,
    nameHistory: [{ name: '碩一', upToSemester: FROM }],
  })];
  const plan = S.undoRolloverInPlace_(list, FROM);
  assert.equal(plan.unGraduated.length, 1);
  assert.equal(plan.renamed.length, 1);
  assert.strictEqual(list[0].graduatedSemester, null);
  assert.strictEqual(list[0].active, true);
  assert.equal(list[0].name, '碩一');
});

test('null 元素與缺欄位不會炸', () => {
  const list = [null, {}, cls({ id: 'h', graduatedSemester: FROM })];
  const plan = S.undoRolloverInPlace_(list, FROM);
  assert.equal(plan.unGraduated.length, 1);
});

test('乾淨資料 → 完全不動，摘要兩個數字都是 0', () => {
  const list = [cls({ id: 'i' }), cls({ id: 'j', active: false, graduatedSemester: '112-1' })];
  const before = JSON.stringify(list);
  const plan = S.undoRolloverInPlace_(list, FROM);
  assert.equal(JSON.stringify(list), before);
  const sum = S.undoRolloverSummary_(plan, list.length, FROM);
  assert.equal(sum.復原停用, 0);
  assert.equal(sum.復原改名, 0);
});

test('冪等：復原過的資料再跑一次不會有第二次變動', () => {
  const list = [
    cls({ id: 'k', active: false, graduatedSemester: FROM }),
    cls({ id: 'l', name: '產專二', nameHistory: [{ name: '產專一', upToSemester: FROM }] }),
  ];
  S.undoRolloverInPlace_(list, FROM);
  const after1 = JSON.stringify(list);
  const plan2 = S.undoRolloverInPlace_(list, FROM);
  assert.equal(JSON.stringify(list), after1);
  assert.equal(plan2.unGraduated.length, 0);
  assert.equal(plan2.renamed.length, 0);
});

test('摘要把停用班級照名稱分布統計出來（人要靠這個數字決定敢不敢按套用）', () => {
  const list = [
    cls({ id: 'm', name: '碩二', active: false, graduatedSemester: FROM }),
    cls({ id: 'n', name: '碩二', active: false, graduatedSemester: FROM }),
    cls({ id: 'o', name: '四技四A', active: false, graduatedSemester: FROM }),
  ];
  const sum = S.undoRolloverSummary_(S.undoRolloverInPlace_(list, FROM), list.length, FROM);
  assert.equal(sum.復原停用, 3);
  assert.match(sum.停用班級分布, /碩二×2/);
  assert.match(sum.停用班級分布, /四技四A×1/);
});

// ── 往返：模擬那次事故實際落地的形狀，復原後要與原檔逐位元一致 ──────────────
test('往返：graduate 99 + advance 5 的災情形狀，復原後與原檔逐位元一致', () => {
  const original = [];
  for (let i = 0; i < 104; i++) {
    original.push(cls({ id: 'x' + i, deptId: '系' + (i % 20), name: i < 99 ? '碩二' : '產專一', displayName: 'D' + i }));
  }
  const snapshot = JSON.stringify(original);

  // 事故當下實際寫進去的樣子：99 筆 graduate（停用＋畢業註記）、5 筆 advance（改名＋nameHistory）
  const damaged = JSON.parse(snapshot);
  damaged.forEach(function (c, i) {
    if (i < 99) { c.active = false; c.graduatedSemester = FROM; }
    else {
      const oldName = c.name, oldDisplay = c.displayName;
      c.name = '產專二';
      c.displayName = 'D' + i + '(新)';
      c.nameHistory = [{ name: oldName, displayName: oldDisplay, upToSemester: FROM }];
    }
  });
  assert.notEqual(JSON.stringify(damaged), snapshot, '災情資料應該與原檔不同');

  const plan = S.undoRolloverInPlace_(damaged, FROM);
  assert.equal(plan.unGraduated.length, 99);
  assert.equal(plan.renamed.length, 5);
  assert.equal(JSON.stringify(damaged), snapshot, '復原後應與原檔逐位元一致');
});
