// verify/drive.mjs — 端到端驅動：把 dev/index.html 真的跑起來、操作五張票的 UI 流程、截圖存證。
// 用法（playwright 裝在 scratchpad）：
//   node verify/drive.mjs
// 環境變數：VERIFY_SCRATCH=scratchpad 路徑（預設用本機已知路徑）。
// 斷言失敗不中止：記錄 ❌ 後繼續；結束時輸出逐步結果與 console error 清單。

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const SCRATCH = process.env.VERIFY_SCRATCH ||
  'C:/Users/user/AppData/Local/Temp/claude/G---------00Claude-Working-Directory-scc-tutorsys/a7e8c1dd-bdc7-4338-a667-938ec780236c/scratchpad';
const SHOTS = path.join(SCRATCH, 'verify-shots');
const XLSX_REAL = 'G:/我的雲端硬碟/00Claude_Working_Directory/forsystems/114-2 班級、家族會議記錄暨班級業務統計.xlsx';

const requireScratch = createRequire(path.join(SCRATCH, 'noop.js'));
const requireRepo = createRequire(path.join(REPO, 'noop.js'));
const { chromium } = requireScratch('playwright');
const { startServers } = requireRepo('./verify/server.js');

// ── 從 dev/index.html 讀出實際常數（不寫死，跟著本體走）──
const indexHtml = fs.readFileSync(path.join(REPO, 'dev', 'index.html'), 'utf8');
const APPS_SCRIPT_URL = indexHtml.match(/const APPS_SCRIPT_URL = '([^']+)'/)[1];
const ROOT_FOLDER_ID = indexHtml.match(/const ROOT_FOLDER_ID\s*=\s*'([^']+)'/)[1];

fs.mkdirSync(SHOTS, { recursive: true });

// ── 結果記錄 ──
const results = [];
const consoleErrors = [];
const dialogs = [];
let shotNo = 0;
function log(mark, flow, msg) {
  const line = `${mark} [${flow}] ${msg}`;
  results.push(line);
  console.log(line);
}
async function shot(page, desc) {
  shotNo++;
  const name = String(shotNo).padStart(2, '0') + '-' + desc + '.png';
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
  console.log('   📸', name);
  return name;
}
async function check(flow, desc, fn) {
  try {
    await fn();
    log('✅', flow, desc);
    return true;
  } catch (e) {
    log('❌', flow, desc + ' —— ' + (e && e.message ? e.message.split('\n')[0] : e));
    return false;
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg || 'expect failed'); }
// flow 區塊容器：內部未捕捉的例外（操作 timeout 等）記錄後繼續下一個 flow，不中止整程
async function flow(name, fn) {
  try { await fn(); } catch (e) {
    log('❌', name, '流程中斷：' + (e && e.message ? e.message.split('\n')[0] : e));
  }
}

// ── 直打 API 探針 helper ──
async function apiCall(action, params, token) {
  const payload = JSON.stringify(Object.assign({ action, rootFolderId: ROOT_FOLDER_ID, sessionToken: token }, params || {}));
  const res = await fetch('http://127.0.0.1:8788/exec', { method: 'POST', body: new URLSearchParams({ payload }) });
  return res.json();
}

const servers = startServers();
const adminToken = servers.em.mint('admin@test.local');
const assistantToken = servers.em.mint('assistant@test.local');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

// 路由攔截：GAS → 本機 emulator；gsi → stub；SheetJS CDN → 本機 node_modules；ipapi → 空
await context.route(u => u.href.startsWith(APPS_SCRIPT_URL), async (route) => {
  const req = route.request();
  const res = await fetch('http://127.0.0.1:8788/exec', { method: 'POST', body: req.postData() || '' });
  await route.fulfill({ status: 200, contentType: 'application/json', body: await res.text() });
});
await context.route('https://accounts.google.com/gsi/client*', (route) => route.fulfill({
  status: 200, contentType: 'text/javascript',
  body: 'window.google={accounts:{id:{initialize(){},renderButton(){},disableAutoSelect(){},prompt(){}}}};',
}));
await context.route('https://cdn.sheetjs.com/**', (route) => route.fulfill({
  status: 200, contentType: 'text/javascript',
  body: fs.readFileSync(path.join(SCRATCH, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'), 'utf8'),
}));
await context.route('https://ipapi.co/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

// 預塞 localStorage（鍵名/形狀照 dev/index.html LS_USER_KEY/LS_SESSION_KEY 與 load 恢復邏輯）
await context.addInitScript(({ rootId, token, exp }) => {
  localStorage.setItem('tutor_user_' + rootId, JSON.stringify({ email: 'admin@test.local', name: '測試管理員', picture: '' }));
  localStorage.setItem('tutor_session_' + rootId, JSON.stringify({ token, exp, email: 'admin@test.local' }));
}, { rootId: ROOT_FOLDER_ID, token: adminToken.token, exp: adminToken.exp });

const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('dialog', async (d) => { dialogs.push(d.type() + ': ' + d.message().split('\n')[0]); await d.accept(); });

const evid = {}; // API 探針回應體存證

// ══ 開場：免登入直接進主畫面 ═══════════════════════════════════════════════════
await page.goto('http://127.0.0.1:8787/dev/index.html');
await check('boot', '載入後直接進主畫面（session 免登入）', async () => {
  await page.locator('#app').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.nav-btn', { hasText: '後台管理' }).waitFor({ timeout: 10000 });
});
await shot(page, 'boot-主畫面');

// ══ A：按鈕回饋＋checkbox ═══════════════════════════════════════════════════════
await flow('A', async () => {
  await page.locator('.nav-btn', { hasText: '後台管理' }).click();
  await page.locator('[data-admin-tab="colleges"]').click();
  await page.locator('[data-action="college-new"]').waitFor();
  await page.locator('[data-action="college-new"]').click();
  await page.locator('#college-form').waitFor();
  await shot(page, 'A-新增學院表單含停用checkbox');
  await page.locator('#college-form .field label', { hasText: '停用' }).screenshot({ path: path.join(SHOTS, String(++shotNo).padStart(2, '0') + '-A-checkbox特寫.png') });
  await page.fill('#college-name', '測試學院');
  // 正面斷言：#college-id 不再有 required、留空並直接送出，靠程式內「id 留空自動 slugify」
  // 的路徑衍生 id（修法：移除 required、加 placeholder 提示，見回報）。
  await check('A', '學院 ID 欄位無 required 屬性（留空可送出）', async () => {
    const required = await page.locator('#college-id').getAttribute('required');
    expect(required === null, 'required 屬性=' + required);
  });
  await check('A', '學院 ID 欄位有留空提示 placeholder', async () => {
    const ph = await page.locator('#college-id').getAttribute('placeholder');
    expect(ph && ph.includes('自動'), 'placeholder=' + ph);
  });
  expect((await page.locator('#college-id').inputValue()) === '', '#college-id 應維持留空才能驗證自動衍生');
  const saveBtn = page.locator('#college-form button[type=submit]');
  await saveBtn.click();
  await shot(page, 'A-儲存pending態');
  await check('A', '按下儲存後出現「處理中…」pending 態', async () => {
    const txt = await saveBtn.textContent();
    expect(txt.includes('處理中'), '按鈕文字=' + txt);
  });
  await check('A', '儲存成功 toast「已儲存」（留空 ID 未被原生驗證擋下）', async () => {
    await page.locator('.toast', { hasText: '已儲存' }).waitFor({ timeout: 5000 });
  });
  await check('A', '學院列表出現「測試學院」，且 ID 欄非空（自動衍生成功）', async () => {
    const row = page.locator('#admin-tab-content tr', { hasText: '測試學院' });
    await row.waitFor({ timeout: 3000 });
    const idCell = (await row.locator('td').first().textContent() || '').trim();
    evid['A-college-derived-id'] = idCell;
    expect(idCell.length > 0, 'ID 欄=' + JSON.stringify(idCell));
  });
  await shot(page, 'A-學院清單含新列（ID自動衍生）');
});

// ══ B：軟刪除＋fail-closed 探針 ═══════════════════════════════════════════════
await flow('B', async () => {
  const collegeRow = page.locator('#admin-tab-content tr', { hasText: '測試學院' });
  await collegeRow.locator('[data-action="college-delete"]').click();
  await check('B', '刪除學院後列消失（confirm 自動接受）', async () => {
    await page.locator('.toast', { hasText: '已刪除' }).waitFor({ timeout: 5000 });
    await collegeRow.waitFor({ state: 'detached', timeout: 3000 });
  });
  await shot(page, 'B-學院已刪除');

  // 建一個系所再刪，供 classResolve fail-closed 探針
  await page.locator('[data-admin-tab="departments"]').click();
  await page.locator('[data-action="dept-new"]').click();
  await page.locator('#dept-form').waitFor();
  await page.fill('#dept-id', '測試刪除系');
  await page.fill('#dept-name', '測試刪除系');
  await page.locator('#dept-form button[type=submit]').click();
  await page.locator('.toast', { hasText: '已儲存' }).waitFor({ timeout: 5000 });
  const deptRow = page.locator('#admin-tab-content tr', { hasText: '測試刪除系' });
  await deptRow.locator('[data-action="dept-delete"]').click();
  await check('B', '刪除系所後列消失', async () => {
    await deptRow.waitFor({ state: 'detached', timeout: 5000 });
  });
  await shot(page, 'B-系所已刪除');
});
await check('B', '🔍 classResolve 命中已刪除系所名 → fail-closed 拒絕', async () => {
  const r = await apiCall('classResolve', { deptName: '測試刪除系', className: '測試一A' }, adminToken.token);
  evid['B-classResolve-deleted-dept'] = JSON.stringify(r);
  expect(r.success === false && /department disabled/.test(r.error || ''), '回應=' + JSON.stringify(r));
});

// ══ C：導師歷史＋期中更換 ═══════════════════════════════════════════════════════
await flow('C', async () => {
  await page.locator('[data-admin-tab="classes"]').click();
  const clsRowA = page.locator('#admin-tab-content tr', { hasText: '農園系_四技一A' });
  await clsRowA.locator('[data-action="class-history"]').click();
  await check('C', '歷史 modal 顯示「尚無異動紀錄」', async () => {
    await page.locator('#modal-box', { hasText: '尚無異動紀錄' }).waitFor({ timeout: 8000 });
  });
  await shot(page, 'C-歷史尚無異動');
  await page.locator('[data-action="midterm-open"]').click();
  await page.locator('#midterm-form').waitFor();
  await page.fill('#mid-t1-name', '李新師');
  await page.fill('#mid-t1-email', 'lee@test.local');
  await shot(page, 'C-期中更換表單');
  await page.locator('#midterm-form button[type=submit]').click();
  await check('C', '期中更換送出成功 toast', async () => {
    await page.locator('.toast', { hasText: '已更換導師並寫入異動紀錄' }).waitFor({ timeout: 8000 });
  });
  await clsRowA.locator('[data-action="class-history"]').click();
  const todayLabel = (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日更換';
  await check('C', '歷史出現「期中更換」列＋「' + todayLabel + '」', async () => {
    await page.locator('#modal-box td', { hasText: '期中更換' }).first().waitFor({ timeout: 8000 });
    await page.locator('#modal-box td', { hasText: todayLabel }).first().waitFor({ timeout: 2000 });
  });
  await shot(page, 'C-歷史含期中更換列');
  await page.locator('#modal-box [data-action="close-modal"]').click();

  // 編輯加導師2 → 歷史多一筆「手動編輯」
  await clsRowA.locator('[data-action="class-edit"]').click();
  await page.locator('#class-form').waitFor();
  await page.fill('#tutor2-name', '王助教');
  await page.fill('#tutor2-email', 'assistant2@test.local');
  await page.locator('#class-form button[type=submit]').click();
  await page.locator('.toast', { hasText: '已儲存' }).waitFor({ timeout: 8000 });
  await clsRowA.locator('[data-action="class-history"]').click();
  await check('C', '一般編輯改導師後，歷史多一筆「手動編輯」', async () => {
    await page.locator('#modal-box td', { hasText: '手動編輯' }).first().waitFor({ timeout: 8000 });
  });
  await shot(page, 'C-歷史含手動編輯列');
  await page.locator('#modal-box [data-action="close-modal"]').click();
});

// ══ D：換學期升級 ═══════════════════════════════════════════════════════════════
await flow('D', async () => {
await page.locator('[data-admin-tab="semesters"]').click();
await page.locator('[data-action="rollover-open"]').click();
await page.locator('#roll-from').waitFor();
await page.selectOption('#roll-from', '114-2');
await page.selectOption('#roll-to', '115-1');
await page.locator('#roll-preview-btn').click();
await check('D', '預覽產生：農園四技一A→四技二A（帶入升級）', async () => {
  const row = page.locator('#roll-preview tr', { hasText: '四農園一A' });
  await row.waitFor({ timeout: 10000 });
  expect(await row.locator('select').inputValue() === 'advance', 'action 非 advance');
  expect(await row.locator('input[data-roll-newname]').inputValue() === '四技二A', 'newName 非四技二A');
});
await check('D', '農園四技四A→畢業；碩二→畢業', async () => {
  expect(await page.locator('#roll-preview tr', { hasText: '四農園四A' }).locator('select').inputValue() === 'graduate', '四技四A 非 graduate');
  expect(await page.locator('#roll-preview tr', { hasText: '碩農園二' }).locator('select').inputValue() === 'graduate', '碩二 非 graduate');
});
await check('D', '獸醫四技四A→四技五A（graduationGrade=5 覆寫）', async () => {
  const row = page.locator('#roll-preview tr', { hasText: '四獸醫四A' });
  expect(await row.locator('select').inputValue() === 'advance', '非 advance');
  expect(await row.locator('input[data-roll-newname]').inputValue() === '四技五A', 'newName 非四技五A');
});
await check('D', '家族陳美惠→keep＋標黃（uncertain）', async () => {
  const row = page.locator('#roll-preview tr', { hasText: '森林家族(陳美惠)' });
  expect(await row.locator('select').inputValue() === 'keep', '非 keep');
  const style = await row.getAttribute('style');
  expect(style && style.includes('warning-bg'), '未標黃：' + style);
});
await shot(page, 'D-升級預覽整表');

// 🔍 撞名探針：把四技一A的新班名改成既有「碩二」→ 套用 → 該列 error、其他列成功
const rowA = page.locator('#roll-preview tr', { hasText: '四農園一A' });
await rowA.locator('input[data-roll-newname]').fill('碩二');
await page.locator('#roll-apply-btn').click();
await check('D', '🔍 套用：撞名列進 errors、其他列成功（改名1/畢業2/保留1/失敗1）', async () => {
  await page.locator('#roll-preview', { hasText: '套用完成' }).waitFor({ timeout: 10000 });
  const txt = await page.locator('#roll-preview').textContent();
  expect(txt.includes('改名 1 班'), '摘要=' + txt.slice(0, 200));
  expect(txt.includes('畢業 2 班'), '畢業數不符');
  expect(/already exists|failed|失敗 1/.test(txt), '無失敗列');
});
await shot(page, 'D-套用結果摘要含撞名失敗');
await page.locator('#modal-box [data-action="close-modal"]').last().click();

await page.locator('[data-admin-tab="classes"]').click();
await check('D', '班級列表：獸醫班已改名四技五A', async () => {
  await page.locator('#admin-tab-content tr', { hasText: '四技五A' }).waitFor({ timeout: 5000 });
});
await shot(page, 'D-班級列表改名生效');
await check('D', '🔍 overviewStats(114-2) 回舊班名（nameHistory 生效）', async () => {
  const r = await apiCall('overviewStats', { semester: '114-2' }, adminToken.token);
  evid['D-overviewStats-114-2'] = JSON.stringify(r).slice(0, 800);
  const row = (r.data.rows || []).find((x) => x.classId === '獸醫系_四技四A');
  expect(row && row.displayName === '四獸醫四A', '114-2 顯示=' + (row && row.displayName));
  const r2 = await apiCall('overviewStats', { semester: '115-1' }, adminToken.token);
  const row2 = (r2.data.rows || []).find((x) => x.classId === '獸醫系_四技四A');
  evid['D-overviewStats-115-1-row'] = JSON.stringify(row2);
  expect(row2 && /五/.test(row2.displayName), '115-1 顯示=' + (row2 && row2.displayName));
});
});

// ══ E：匯入 v3（真實統計表）═══════════════════════════════════════════════════
await flow('E', async () => {
await page.locator('[data-admin-tab="roster"]').click();
await page.setInputFiles('#roster-file', XLSX_REAL);
await check('E', '偵測為統計表格式＋摘要數字（總 369／家族 61／uncertain 63）', async () => {
  await page.locator('#roster-format', { hasText: '統計表格式' }).waitFor({ timeout: 30000 });
  await page.locator('#roster-preview', { hasText: '共 369 列' }).waitFor({ timeout: 30000 });
  const summary = await page.locator('#roster-preview p').first().textContent();
  evid['E-summary-1st'] = summary;
  expect(summary.includes('待人工確認（標黃）63'), '摘要=' + summary);
});
await shot(page, 'E-匯入偵測與摘要');
await check('E', '預覽表在 1280px 視窗下：外層可橫向捲動＋表格撐寬觸發捲動＋班級/導師欄 white-space:nowrap（不逐字直排）', async () => {
  const wrap = page.locator('#roster-preview .table-wrap');
  const overflowX = await wrap.evaluate((el) => getComputedStyle(el).overflowX);
  expect(overflowX === 'auto', 'table-wrap overflow-x=' + overflowX);
  const scrollInfo = await wrap.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  evid['E-table-wrap-scroll'] = JSON.stringify(scrollInfo);
  const table = page.locator('#roster-preview-table');
  const tableWidth = await table.evaluate((el) => el.getBoundingClientRect().width);
  expect(tableWidth >= 1080, 'table 寬度=' + tableWidth + '（應吃到 min-width:1080px）');
  // white-space:nowrap 是「不逐字直排」的結構性保證（CSS 規範下該屬性使該儲存格文字不可換行，
  // 與同列其他欄位（如「原因/提示」自由文字，本就允許正常換行）的列高無關，故不用列高間接推論）。
  for (const label of ['班級', '導師1', '導師2']) {
    const ws = await page.locator('#roster-preview-table td[data-label="' + label + '"]').first().evaluate((el) => getComputedStyle(el).whiteSpace);
    expect(ws === 'nowrap', label + ' 欄 white-space=' + ws);
  }
});
await shot(page, 'E-預覽表上段');
await page.locator('#roster-preview .table-wrap').evaluate((el) => { el.scrollTop = 0; });
// 捲到含「現行→匯入」對照與標黃列處多截幾張
await page.locator('#roster-preview tr', { hasText: '現行：' }).first().scrollIntoViewIfNeeded().catch(() => {});
await shot(page, 'E-預覽表-現行對照');
await page.locator('#roster-preview tr[style*="warning"]').first().scrollIntoViewIfNeeded().catch(() => {});
await shot(page, 'E-預覽表-標黃列');
await page.locator('[data-roster-select="changed"]').click();
await page.locator('[data-action="roster-confirm"]').scrollIntoViewIfNeeded();
await page.locator('[data-action="roster-confirm"]').click();
await check('E', '確認匯入成功（成功/失敗摘要出現）', async () => {
  await page.locator('.toast', { hasText: '匯入完成' }).waitFor({ timeout: 60000 });
  const toast = await page.locator('.toast', { hasText: '匯入完成' }).textContent();
  evid['E-import-1st-toast'] = toast;
});
await shot(page, 'E-第一次匯入結果');

// 🔍 冪等性：同檔再上傳 → 多數列變「無變動」
await page.locator('[data-admin-tab="roster"]').click();
await page.setInputFiles('#roster-file', XLSX_REAL);
await check('E', '🔍 同檔再上傳：多數列變「無變動」（冪等性）', async () => {
  await page.locator('#roster-preview', { hasText: '共 369 列' }).waitFor({ timeout: 30000 });
  const summary = await page.locator('#roster-preview p').first().textContent();
  evid['E-summary-2nd'] = summary;
  const m = summary.match(/無變動 (\d+)/);
  expect(m && Number(m[1]) >= 250, '無變動數=' + (m && m[1]) + '，摘要=' + summary);
});
await shot(page, 'E-二次上傳冪等摘要');
});

// ══ F：畢業／停用班補匯被拒＋補救提示（Ticket 3）═══════════════════════════════
// 流程 D 的 rollover 套用已把「農園系_碩二」畢業（active:false + graduatedSemester）。
// 用標準範本 CSV 直打匯入該班（class disabled fail-closed），連帶一列仍在學的
// 「森林系_家族陳美惠」驗證同批次「單列失敗不中斷整批」＋前端補救提示文字正確出現。
await flow('F', async () => {
  const header = ['學院', '系所', '導師制度', '班級名稱(原始)', '班級顯示名稱(可修改)', '應繳班會份數', '導師1姓名', '導師1email', '導師2姓名', '導師2email'];
  const row1 = ['農學院', '農園系', '', '碩二', '', '', '', '', '', ''];      // 已畢業班 → 預期 class disabled
  const row2 = ['', '森林系', '', '家族陳美惠', '', '', '', '', '', ''];     // 仍在學班 → 預期成功
  const csv = '﻿' + [header, row1, row2].map((r) => r.join(',')).join('\n');
  const csvPath = path.join(SCRATCH, 'verify-disabled-class-import.csv');
  fs.writeFileSync(csvPath, csv, 'utf8');

  await page.locator('[data-admin-tab="roster"]').click();
  await page.setInputFiles('#roster-file', csvPath);
  await check('F', '偵測為標準範本格式，共 2 列', async () => {
    await page.locator('#roster-format', { hasText: '標準範本格式' }).waitFor({ timeout: 10000 });
    await page.locator('#roster-preview', { hasText: '共 2 列' }).waitFor({ timeout: 10000 });
  });
  await shot(page, 'F-畢業班補匯預覽表');
  await page.locator('[data-roster-select="all"]').click();
  // 不靠 toast 文字比對（4200ms 才自動移除，前一步 E 的 toast 可能還留在 DOM 造成誤判）——
  // 直接攔截這次 adminImportRoster 的真實回應體當事實依據。
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().startsWith(APPS_SCRIPT_URL), { timeout: 20000 }),
    page.locator('[data-action="roster-confirm"]').click(),
  ]);
  const body = await resp.json();
  evid['F-import-response'] = JSON.stringify(body).slice(0, 1500);
  await check('F', 'API 回應：成功 1 列、失敗 1 列，錯誤訊息為 class disabled: 農園系_碩二', async () => {
    const data = body.data || body;
    expect(data.successCount === 1, 'successCount=' + data.successCount + '，body=' + JSON.stringify(body).slice(0, 400));
    expect(Array.isArray(data.errors) && data.errors.length === 1, 'errors=' + JSON.stringify(data.errors));
    expect(/class disabled: 農園系_碩二/.test(data.errors[0].error), 'error=' + JSON.stringify(data.errors[0]));
  });
  await check('F', '畫面渲染出錯誤列＋畢業班補救提示文字', async () => {
    await page.locator('#roster-preview', { hasText: 'class disabled' }).waitFor({ timeout: 10000 });
    const html = await page.locator('#roster-preview').innerHTML();
    evid['F-disabled-class-error-block'] = html.slice(0, 2000);
    expect(html.includes('該班級已畢業／已停用'), '缺少畢業班補救提示文字（「該班級已畢業／已停用」）');
    expect(html.includes('取消勾選「啟用」還原狀態'), '缺少還原步驟提示文字');
  });
  await shot(page, 'F-畢業班補匯被拒＋補救提示');
});

// ══ 🔍 加碼探針 ═══════════════════════════════════════════════════════════════
await check('probe', '🔍 竄改 session token 一字元 → 拒絕', async () => {
  const bad = adminToken.token.slice(0, -2) + (adminToken.token.slice(-2) === 'aa' ? 'bb' : 'aa');
  const r = await apiCall('bootstrap', {}, bad);
  evid['probe-tampered-token'] = JSON.stringify(r);
  expect(r.data && r.data.error === 'Session expired', '回應=' + JSON.stringify(r));
});
await check('probe', '🔍 staffAssistant token 打 adminRolloverApply → admin only 拒絕', async () => {
  const r = await apiCall('adminRolloverApply', { fromSemester: '114-2', toSemester: '115-1', rows: [{ classId: 'x', action: 'keep' }] }, assistantToken.token);
  evid['probe-assistant-admin-action'] = JSON.stringify(r);
  expect(r.success === false && r.error === 'admin only', '回應=' + JSON.stringify(r));
});

// ══ 收尾 ═══════════════════════════════════════════════════════════════════════
fs.writeFileSync(path.join(SHOTS, 'api-evidence.json'), JSON.stringify(evid, null, 2));
console.log('\n══ 結果 ══');
results.forEach((r) => console.log(r));
console.log('\n══ dialogs（自動接受）══');
dialogs.forEach((d) => console.log(' ', d));
console.log('\n══ console errors ══');
if (!consoleErrors.length) console.log('  （無）');
consoleErrors.forEach((e) => console.log(' ', e.slice(0, 300)));
console.log('\n══ API 探針回應體 ══');
Object.entries(evid).forEach(([k, v]) => console.log(' ', k, '=', String(v).slice(0, 240)));

await browser.close();
servers.close();
const failed = results.filter((r) => r.startsWith('❌')).length;
console.log(`\n完成：${results.length} 步，失敗 ${failed}；截圖 ${shotNo} 張 → ${SHOTS}`);
process.exit(0);
