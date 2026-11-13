/* W6.1 test transform v2: add `await` to RoomRegistry method calls and make callbacks/helpers async.
 * v2 修正：v1 用 [^)]* 匹配实参，遇嵌套括号（如 seeded(3)）会把后续实参挤出调用，
 * 产生「括号平衡但实参丢失」的静默损坏（coopRoom.test.ts L101 实证）。
 * v2 改为括号感知扫描：逐字符配平、跳过字符串字面量，从调用起点走到配平的右括号，
 * 再整体包一层 (await …)。
 * 变量名全集（已 grep 核实）：reg / reg2 / onlineReg。`reg.view` 仍是同步，不包。
 */
const fs = require('fs');

const ASYNC_METHODS = [
  'create', 'join', 'get', 'abandon', 'settle', 'tick', 'sweep', 'submitIntent',
  'offerAutopilot', 'markDisconnected', 'reconnect', 'setSettledFlag', 'listForUser',
  'quotaUsage', 'stats', 'roomIds', 'attachCoop', 'attachPvp',
];

/** 从 `src` 的 `start`（指向 '('）出发找配平的 ')' 下标；识别字符串/模板字面量；失败返回 -1。 */
function matchCall(src, start) {
  let depth = 0, i = start, quote = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 把 `<recv>.<method>(...)` 全部包成 `(await <recv>.<method>(...))`。 */
function wrapCalls(content, receivers, methods) {
  const re = new RegExp(`\\b(${receivers.join('|')})\\.(${methods.join('|')})\\(`, 'g');
  let out = '';
  let last = 0, m;
  while ((m = re.exec(content)) !== null) {
    const open = m.index + m[0].length - 1; // 指向 '('
    const close = matchCall(content, open);
    if (close === -1) { re.lastIndex = m.index + m[0].length; continue; }
    const whole = content.slice(m.index, close + 1);
    if (whole.includes('await ') || /^\(await/.test(content.slice(m.index, m.index + 6))) {
      // 已有 await（含本次替换产物 / 原本就有），不重复包。
      continue;
    }
    out += content.slice(last, m.index) + '(await ' + whole + ')';
    last = close + 1;
    re.lastIndex = last;
  }
  out += content.slice(last);
  return out;
}

function transform(content) {
  // 1. reg.<method>(...) -> (await reg.<method>(...))，括号感知。
  content = wrapCalls(content, ['onlineReg', 'reg2', 'reg'], ASYNC_METHODS);

  // 2. helper 调用点 -> await（跳过 `function name(` 定义）。同样括号感知。
  for (const name of ['twoPlayers', 'makeCoop']) {
    const re = new RegExp(`(?<!function )\\b${name}\\(`, 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(content)) !== null) {
      const open = m.index + m[0].length - 1;
      const close = matchCall(content, open);
      if (close === -1) { re.lastIndex = m.index + m[0].length; continue; }
      const whole = content.slice(m.index, close + 1);
      if (whole.startsWith('await ') || content.slice(m.index, m.index + 7).startsWith('await ') || /^\(await/.test(content.slice(Math.max(0, m.index - 1), m.index))) {
        continue;
      }
      out += content.slice(last, m.index) + '(await ' + whole + ')';
      last = close + 1;
      re.lastIndex = last;
    }
    out += content.slice(last);
    content = out;
  }

  // 3. test('...', () =>  ->  test('...', async () =>
  content = content.replace(/(\btest\(\s*(['"])[^'"]*\2\s*,\s*)(\(\)\s*=>)/g, '$1async $3');

  // 4. helper 定义 -> async
  content = content.replace(/\bfunction twoPlayers\(/g, 'async function twoPlayers(');
  content = content.replace(/\bfunction makeCoop\(/g, 'async function makeCoop(');

  return content;
}

const files = [
  'E:/Six/MonsterPK/backend/tests/roomRegistry.test.ts',
  'E:/Six/MonsterPK/backend/tests/coopRoom.test.ts',
];

for (const f of files) {
  const before = fs.readFileSync(f, 'utf8');
  const after = transform(before);
  fs.writeFileSync(f, after, 'utf8');
  const added = (after.match(/\(await (?:onlineReg|reg2|reg)\./g) || []).length;
  console.log(`transformed ${f}: wrapped calls = ${added}, changed = ${before !== after}`);
}
