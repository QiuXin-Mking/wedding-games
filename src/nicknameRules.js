/**
 * 昵称池规则与校验（docs/01 §3）。
 *
 * 这里只实现**可机器判定**的 U1~U5。U6（同音）与 U7（具象）无法在不引入
 * 拼音库 / 词库的前提下机器判定，而 C6 禁止引入依赖 —— 这两条由人工审核承接
 * （AC-23 具象抽查、AC-27 听辨验收）。校验报告会显式说明这一点，
 * 避免「脚本全绿」被误读为「七条全过」。
 *
 * 服务端启动与 tools/check-nicknames.js 共用本文件，不存在两份规则。
 */

import { RULES } from './protocol.js';

/** 同一首字最多出现的条数（U3） */
export const MAX_SAME_FIRST_CHAR = 12;
/** 同一末字最多出现的条数。治 U2/U6 都抓不到的「听感同质」，如 星光/月光/极光 */
export const MAX_SAME_LAST_CHAR = 4;
/** 昵称长度范围（U4，汉字数） */
export const MIN_LEN = 4;
export const MAX_LEN = 6;

/**
 * U5 禁用词表。
 * 判定标准是「**这话能不能当众对一位 56 岁的长辈说**」，不是「这个词好不好听」。
 * 上一版池子栽在这里：贪吃的仓鼠 / 爱赖床的熊猫 / 圆滚滚的柯基 —— 每个词单看都可爱，
 * 落到具体某个人头上再投到婚礼大屏，就成了当众说她又馋又懒又慢。
 */
export const BANNED = Object.freeze({
  食量身材: ['吃', '馋', '贪', '胖', '肥', '圆滚', '肉', '膘', '口福', '肚皮'],
  懒惰迟钝: ['懒', '赖床', '睡', '打盹', '发呆', '呆', '慢', '拖', '笨', '迟'],
  外貌年龄: ['丑', '秃', '矮', '短', '老', '皱'],
  排序羞辱: ['最后', '倒数', '垫底'],
  婚礼忌讳: ['吃席', '白', '孝', '离', '散', '分', '单', '空', '断', '落', '梨', '破', '龟', '驴'],
});

/**
 * 禁用词豁免白名单。
 *
 * 禁用词按**语义**判定：动物学名里的字若不构成对人的评价，可豁免，
 * 但必须逐条列在这里并写明理由 —— 不允许在校验代码里开特例分支。
 */
export const WHITELIST = Object.freeze({
  老虎: '「老」是虎的固定名，无年龄义，没人会把「威风的老虎」听成在说年纪',
});

const HAN_ONLY = /^[一-龥]+$/;

/** 把整条昵称按白名单挖空，剩下的部分再去匹配禁用词 */
function maskWhitelisted(name) {
  let masked = name;
  for (const word of Object.keys(WHITELIST)) {
    masked = masked.split(word).join('\u0000');
  }
  return masked;
}

/**
 * 校验昵称池。
 * @param {string[]} pool
 * @param {{expectSize?: number}} [opts]
 * @returns {{ok: boolean, checks: Array<{id: string, desc: string, ok: boolean, detail: string}>, manual: string[]}}
 */
export function validatePool(pool, opts = {}) {
  const expectSize = opts.expectSize ?? RULES.NICKNAME_POOL_SIZE;
  const checks = [];
  const add = (id, desc, ok, detail = '') => checks.push({ id, desc, ok, detail });

  if (!Array.isArray(pool)) {
    add('U0', '池必须是数组', false, `实际是 ${typeof pool}`);
    return { ok: false, checks, manual: [] };
  }

  add('U0', `池容量恰为 ${expectSize}`, pool.length === expectSize, `实际 ${pool.length} 条`);

  // U1 整条两两不同
  const dupWhole = countDuplicates(pool);
  add('U1', '400 条整条两两不同', dupWhole.length === 0, fmtList(dupWhole));

  // U2 核心词（末二字）两两不同 —— 直接杀死「8 条都以柯基结尾」
  const dupTail = countDuplicates(pool.map((n) => n.slice(-2)));
  add('U2', '核心词（末二字）零复用', dupTail.length === 0, fmtList(dupTail));

  // U3 同一首字 <= 12
  const firstOver = overLimit(pool.map((n) => n[0]), MAX_SAME_FIRST_CHAR);
  add('U3', `同一首字 <= ${MAX_SAME_FIRST_CHAR} 条`, firstOver.length === 0, fmtList(firstOver));

  // U3b 同一末字 <= 4 —— 治「听感同质」，U2/U6 都抓不到
  const lastOver = overLimit(pool.map((n) => n[n.length - 1]), MAX_SAME_LAST_CHAR);
  add('U3b', `同一末字 <= ${MAX_SAME_LAST_CHAR} 条（听感同质）`, lastOver.length === 0, fmtList(lastOver));

  // U4 长度与字符集
  const badLen = pool.filter((n) => n.length < MIN_LEN || n.length > MAX_LEN);
  add('U4', `长度 ${MIN_LEN}~${MAX_LEN} 汉字`, badLen.length === 0, fmtList(badLen));
  const badChar = pool.filter((n) => !HAN_ONLY.test(n));
  add('U4b', '纯汉字（无英文/数字/符号/表情）', badChar.length === 0, fmtList(badChar));

  // U5 禁用词
  const hits = [];
  for (const name of pool) {
    const masked = maskWhitelisted(name);
    for (const [cat, words] of Object.entries(BANNED)) {
      for (const w of words) {
        if (masked.includes(w)) hits.push(`${name}（${cat}:${w}）`);
      }
    }
  }
  add('U5', '禁用词零命中', hits.length === 0, fmtList(hits));

  return {
    ok: checks.every((c) => c.ok),
    checks,
    manual: [
      'U6 核心词不得同音（且须排除与池外常见词的歧义，如「枇杷 / 琵琶」）—— 需人工，见 AC-27 听辨验收',
      'U7 核心词必须具象（判定法：能不能画出来）—— 需人工，见 AC-23 抽查',
      '400 条须经一位 50 岁以上的人独立过目 —— 见 AC-22',
    ],
  };
}

function countDuplicates(items) {
  const seen = new Map();
  for (const it of items) seen.set(it, (seen.get(it) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
}

function overLimit(items, limit) {
  const seen = new Map();
  for (const it of items) seen.set(it, (seen.get(it) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > limit).map(([k, n]) => `${k}×${n}`);
}

function fmtList(list, max = 8) {
  if (list.length === 0) return '';
  const head = list.slice(0, max).join('、');
  return list.length > max ? `${head} …共 ${list.length} 处` : head;
}
