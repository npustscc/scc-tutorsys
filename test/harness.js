// 測試載入器：從 dev/Code.gs 就地抽出指定的純函式，在隔離的 vm context 中執行。
// 完全不修改 dev/Code.gs —— 測試檔讀的是同一份正式碼，改壞邏輯測試就會紅燈。
// （比照 scc-infosys 的 test/harness.js，差異只在於這裡讀的是 Code.gs 而非 index.html——
//  本專案這一輪只實作後端，核章狀態機/角色解析等純函式都活在 Code.gs 裡。）
//
// 用法：
//   const { load } = require('./harness');
//   const S = load(['resolveRoles_', 'isClassTutor_'], { BOOTSTRAP_ADMINS: ['boot@x.com'] });
//   S.resolveRoles_('a@b.com', config, departments, classes);
//
// 限制：以「跳過字串/註解的括號配對」抽出函式主體，適用本專案這類無 DOM/無 GAS 全域依賴的
// 純函式；若函式字串字面量內含不成對的大括號（本專案目前沒有），需改用更完整的解析器。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_PATH = path.join(__dirname, '..', 'dev', 'Code.gs');

function readGs() {
  return fs.readFileSync(GS_PATH, 'utf8');
}

// 從 src 中，以 openBraceIdx（指向 '{'）為起點，做「字串/註解感知」的括號配對，回傳結束 '}' 的索引。
function matchBrace(src, openBraceIdx) {
  let depth = 0;
  let i = openBraceIdx;
  let str = null;      // 目前所在的字串引號字元（' " `），null = 不在字串內
  let lineComment = false, blockComment = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (str) {
      if (c === '\\') { i++; continue; }         // 跳過跳脫字元
      if (c === str) str = null;                 // 字串結束（含反引號整段跳過，含其 ${} 內大括號）
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('matchBrace: 找不到對應的結束大括號');
}

// 抽出名為 name 的頂層函式宣告原始碼字串。
function extractFunction(src, name) {
  const re = new RegExp('function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('找不到函式：' + name);
  const braceIdx = src.indexOf('{', m.index);
  if (braceIdx === -1) throw new Error('函式無主體：' + name);
  const endIdx = matchBrace(src, braceIdx);
  return src.slice(m.index, endIdx + 1);
}

// 載入一組函式到共用 sandbox。extraGlobals 提供被依賴的全域（常數、資料、被 stub 的 helper 等）。
// 回傳 sandbox 物件：抽出的函式與 extraGlobals 都掛在上面，測試中可讀寫。
function load(names, extraGlobals = {}) {
  const src = readGs();
  const sandbox = Object.assign({
    Date, Math, Number, String, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Array, Object, JSON, Set, Map, console,
  }, extraGlobals);
  vm.createContext(sandbox);
  const code = names.map((n) => extractFunction(src, n)).join('\n\n');
  vm.runInContext(code, sandbox);
  return sandbox;
}

module.exports = { load, extractFunction, matchBrace, GS_PATH };
