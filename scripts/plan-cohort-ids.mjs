#!/usr/bin/env node
// scripts/plan-cohort-ids.mjs — 「班級 id 改用入學學年度」的**唯讀**遷移對照表。
//
//   node scripts/plan-cohort-ids.mjs <classes.json 路徑> [--year 115] [--out <報告檔>]
//
// 什麼都不寫（除了 --out 指定的報告檔）。用途是在動手之前讓人看清楚三件事：
//   ① 每個班會變成什麼 id、反推出來的入學學年度是幾年
//   ② 哪些班**無法自動判斷**（家族班、名稱不是年級格式的）→ 維持現狀
//   ③ 哪些地方**現在的資料就有問題**（同一個階梯上年級重複／缺號／新 id 撞名）
//
// 為什麼要有 ③：入學學年度只能從「現在的年級」反推，所以現在的年級錯了、反推就錯，
// 而且從此每年都會顯示錯。這份報告的價值主要在這裡，不在改名本身。
//
// 決策（使用者 2026-08-19）：方案 B（入學學年度為事實、年級是算出來的）；
// id 格式 `<系所>_<學制前綴><入學學年度><班別>`（例 獸醫系_四技111A）；家族班維持現狀。

import fs from 'node:fs';

const GRADE_CHARS = ['一', '二', '三', '四', '五', '六', '七'];

// 學年度：8/1 換。西元 2026 年 8 月之後 → 民國 115 學年度。
export function academicYear(now) {
  const y = now.getFullYear() - 1911;
  return now.getMonth() + 1 >= 8 ? y : y - 1;
}

// 班名 → { prefix, grade, section }；不是年級格式回 null。
// 非貪婪的 prefix 讓「四技進三」自然解成 四技進 + 三，不會被「四技」搶走。
export function parseGradeName(name) {
  const m = /^(.*?)([一二三四五六七])([A-Za-z]?)$/.exec(String(name || ''));
  if (!m) return null;
  const grade = GRADE_CHARS.indexOf(m[2]) + 1;
  if (!grade || !m[1]) return null;              // prefix 空的（例如班名只有「一」）也不處理
  return { prefix: m[1], grade: grade, section: m[3] || '' };
}

export function planCohortIds(classes, year) {
  const alive = (classes || []).filter((c) => c && c.deleted !== true);
  const rows = [];
  for (const c of alive) {
    const p = parseGradeName(c.name);
    const base = { id: c.id, name: c.name, deptId: c.deptId, systemId: c.systemId || null };
    if (!p) {
      rows.push(Object.assign(base, {
        kind: /家族/.test(c.name || '') ? 'family' : 'other',
        newId: c.id, entryYear: null, note: '維持現狀（非年級制）',
      }));
      continue;
    }
    const entryYear = year - p.grade + 1;
    rows.push(Object.assign(base, {
      kind: 'graded', prefix: p.prefix, grade: p.grade, section: p.section,
      entryYear: entryYear,
      newId: c.deptId + '_' + p.prefix + entryYear + p.section,
      nextYearName: p.prefix + (GRADE_CHARS[p.grade] || ('第' + (p.grade + 1) + '級')) + p.section,
      note: '',
    }));
  }

  // 新 id 撞名：同系、同學制前綴、同入學年、同班別出現兩次以上＝現在就有重複
  const byNew = {};
  rows.forEach((r) => { (byNew[r.newId] = byNew[r.newId] || []).push(r.id); });
  const collisions = Object.keys(byNew).filter((k) => byNew[k].length > 1)
    .map((k) => ({ newId: k, from: byNew[k] }));

  // 階梯體檢：同 (系所, 前綴, 班別) 的年級應該是連號、不重複
  const ladders = {};
  rows.filter((r) => r.kind === 'graded').forEach((r) => {
    const key = r.deptId + '｜' + r.prefix + (r.section ? '｜' + r.section : '');
    (ladders[key] = ladders[key] || []).push(r.grade);
  });
  const ladderIssues = [];
  Object.keys(ladders).sort().forEach((k) => {
    const gs = ladders[k].slice().sort((a, b) => a - b);
    const dup = gs.filter((g, i) => i && g === gs[i - 1]);
    const gaps = [];
    for (let g = gs[0]; g < gs[gs.length - 1]; g++) if (gs.indexOf(g) === -1) gaps.push(g);
    if (dup.length || gaps.length) {
      ladderIssues.push({ ladder: k, grades: gs, duplicated: [...new Set(dup)], missing: gaps });
    }
  });

  return { year, rows, collisions, ladderIssues };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) throw new Error('用法：node scripts/plan-cohort-ids.mjs <classes.json> [--year 115] [--out 報告檔]');
  const yi = process.argv.indexOf('--year');
  const year = yi === -1 ? academicYear(new Date()) : Number(process.argv[yi + 1]);
  const plan = planCohortIds(JSON.parse(fs.readFileSync(file, 'utf8')), year);

  const graded = plan.rows.filter((r) => r.kind === 'graded');
  const family = plan.rows.filter((r) => r.kind === 'family');
  const other = plan.rows.filter((r) => r.kind === 'other');
  console.log('[plan] 學年度 ' + year + '（一年級＝' + year + ' 入學）｜班級 ' + plan.rows.length + ' 筆');
  console.log('  年級制（會改 id）：' + graded.length + '｜家族班（不動）：' + family.length + '｜其他不動：' + other.length);
  console.log('\n── 入學學年度分布 ──');
  const byYear = {};
  graded.forEach((r) => { byYear[r.entryYear] = (byYear[r.entryYear] || 0) + 1; });
  Object.keys(byYear).sort().reverse().forEach((y) => console.log('  ' + y + ' 學年度入學（現在 ' + (year - y + 1) + ' 年級）：' + byYear[y] + ' 班'));

  console.log('\n── 範例（每個入學年各取兩筆）──');
  Object.keys(byYear).sort().reverse().forEach((y) => {
    graded.filter((r) => String(r.entryYear) === y).slice(0, 2).forEach((r) => {
      console.log('  ' + r.id.padEnd(24) + ' → ' + r.newId.padEnd(22) + '（' + r.name + '，明年顯示 ' + r.nextYearName + '）');
    });
  });

  if (plan.collisions.length) {
    console.log('\n⚠️ 新 id 撞名（＝現在就有重複，必須先處理）：' + plan.collisions.length + ' 組');
    plan.collisions.forEach((c) => console.log('  ' + c.newId + ' ← ' + c.from.join('、')));
  } else console.log('\n✅ 新 id 沒有撞名');

  if (plan.ladderIssues.length) {
    console.log('\n⚠️ 年級階梯有異常（年級重複或缺號）：' + plan.ladderIssues.length + ' 組');
    plan.ladderIssues.forEach((x) => console.log('  ' + x.ladder + ' 年級=' + x.grades.join(',') +
      (x.duplicated.length ? '｜重複=' + x.duplicated.join(',') : '') +
      (x.missing.length ? '｜缺=' + x.missing.join(',') : '')));
  } else console.log('\n✅ 年級階梯沒有重複或缺號');

  console.log('\n── 不動的那些（前 8 筆）──');
  family.concat(other).slice(0, 8).forEach((r) => console.log('  ' + r.id.padEnd(28) + '（' + r.kind + '）'));

  const oi = process.argv.indexOf('--out');
  if (oi !== -1) {
    fs.writeFileSync(process.argv[oi + 1], JSON.stringify(plan, null, 2), { mode: 0o600 });
    console.log('\n[plan] 完整對照表已寫到 ' + process.argv[oi + 1] + '（含班名，注意個資）');
  }
  console.log('\n[plan] 這是唯讀報告，沒有動任何資料。');
}
