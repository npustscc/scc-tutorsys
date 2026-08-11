#!/usr/bin/env node
// 復原一次「換學期升級」（adminRolloverApply）造成的部分套用。
//
// 為什麼需要這支：adminRolloverApply 的失敗列只收進 errors，**不中斷整批** —— 成功的列
// 照樣寫進 classes.json。而在「席位式」資料（每個系四技一/二/三/四同時存在）上，advance
// 幾乎全部撞名失敗、graduate 卻全部成功，結果是「每個系的最高年級被停用，其他一個都沒升」。
// 114-2 → 115-1 那次實測：200 列失敗、104 列寫入（99 graduate + 5 advance）。
//
//   node scripts/undo-rollover.mjs <classes.json 路徑> --from 114-2          # 預演（預設）
//   node scripts/undo-rollover.mjs <classes.json 路徑> --from 114-2 --apply  # 真的寫
//
// 復原的兩件事：
//   1. graduate：graduatedSemester === <from> 的班 → 還原成 null、active 改回 true。
//      **以 graduatedSemester 當鍵，不是以 active** —— 本來就停用的班不會被誤救活。
//      **是設回 null，不是 delete。** 這份資料的正規形狀就是顯式的 null（import-from-gas
//      寫的是 `graduatedSemester: r.graduatedSemester || null`），欄位整個刪掉的話
//      importer 的 ROSTER_FIELDS 比對會 undefined !== null，每次同步都判定「有更新」。
//      往返測試就是這樣抓到的。
//   2. advance：nameHistory 最後一筆的 upToSemester === <from> → 還原 name/displayName，
//      並把那筆 pop 掉（pop 完若整個陣列空了就連欄位一起刪，回到原本沒有這個欄位的樣子）。
//
// **tutorHistory 不動。** 那是 append-only 的稽核軌跡，事情確實發生過；改寫它等於把
// 「跑過一次失敗的升級」這件事從歷史抹掉。這支會印出有幾筆相關紀錄，要不要另外處理由人決定。

import fs from 'node:fs';

function parseArgs(argv) {
  const out = { path: null, from: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--from') out.from = argv[++i];
    else if (!a.startsWith('--') && !out.path) out.path = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.path || !args.from) {
  console.error('用法：node scripts/undo-rollover.mjs <classes.json 路徑> --from <學期 id> [--apply]');
  console.error('例：  node scripts/undo-rollover.mjs server/data/store/classes.json --from 114-2');
  process.exit(2);
}
if (!/^\d{3}-[12]$/.test(args.from)) {
  console.error('學期 id 格式應為 NNN-N（例：114-2），收到：' + args.from);
  process.exit(2);
}

const raw = fs.readFileSync(args.path, 'utf8');
const classes = JSON.parse(raw);
if (!Array.isArray(classes)) {
  console.error('classes.json 不是陣列，拒絕處理：' + args.path);
  process.exit(2);
}

const unGraduated = [];
const renamed = [];

for (const c of classes) {
  if (!c) continue;

  if (c.graduatedSemester === args.from) {
    unGraduated.push({ id: c.id, dept: c.deptId, name: c.name, wasActive: c.active });
    c.graduatedSemester = null;
    c.active = true;
  }

  const nh = Array.isArray(c.nameHistory) ? c.nameHistory : null;
  const last = nh && nh.length ? nh[nh.length - 1] : null;
  if (last && last.upToSemester === args.from) {
    renamed.push({ id: c.id, dept: c.deptId, from: c.name, to: last.name });
    c.name = last.name;
    if (last.displayName !== undefined) c.displayName = last.displayName;
    nh.pop();
    if (!nh.length) delete c.nameHistory;          // 回到原本「沒有這個欄位」的樣子
  }
}

console.log('檔案：' + args.path);
console.log('學期：' + args.from + '　班級總數：' + classes.length);
console.log('');
console.log('【復原停用】' + unGraduated.length + ' 筆（graduatedSemester 還原成 null、active 改回 true）');
if (unGraduated.length) {
  const byName = {};
  unGraduated.forEach((x) => { byName[x.name] = (byName[x.name] || 0) + 1; });
  console.log('  ' + Object.entries(byName).sort((a, b) => b[1] - a[1])
    .map(([n, k]) => n + '×' + k).join('、'));
}
console.log('');
console.log('【復原改名】' + renamed.length + ' 筆');
renamed.forEach((r) => console.log('  ' + r.dept + '：' + r.from + ' → 還原成 ' + r.to));

if (!renamed.length && !unGraduated.length) {
  console.log('\n沒有找到 ' + args.from + ' 的升級痕跡，這份資料不需要復原（也可能是跑錯環境了）。');
  process.exit(0);
}

if (!args.apply) {
  console.log('\n預演結束，未寫入。確認以上清單無誤後加 --apply 才會真的寫。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = args.path + '.bak-undorollover-' + stamp;
fs.copyFileSync(args.path, bak);
const tmp = args.path + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(classes, null, 2));
fs.renameSync(tmp, args.path);
console.log('\n已寫入。原檔備份於：' + bak);
console.log('提醒：tutorHistory 沒有動（append-only 稽核軌跡），裡面仍留著那次升級的紀錄。');
