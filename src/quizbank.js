/**
 * 题库加载与校验（docs/01 §4.1）。
 *
 * 双题库：questions/test.json（默认）与 questions/wedding.json（真实婚礼题），
 * 由环境变量 QUIZ_BANK=test|wedding 切换，不改代码、不重新构建。
 *
 * **指定 wedding 而文件缺失时必须启动失败，绝不静默回退到测试题库** ——
 * 婚礼当天用错题库是不可接受的事故，这是唯一的防呆。
 */

import { readFileSync, existsSync } from 'node:fs';
import { RULES } from './protocol.js';

export const BANK_TEST = 'test';
export const BANK_WEDDING = 'wedding';
export const VALID_BANKS = [BANK_TEST, BANK_WEDDING];

/** 大屏与控制台上显示的角标，防止彩排与正式场混淆 */
export const BANK_LABEL = Object.freeze({
  [BANK_TEST]: '测试题库',
  [BANK_WEDDING]: '正式题库',
});

export class QuizBank {
  /**
   * @param {string} name
   * @param {Array<{text: string, options: string[], answer: number, spare?: boolean}>} all
   */
  constructor(name, all) {
    this.name = name;
    this.label = BANK_LABEL[name] ?? name;
    /** 正题，按顺序出 */
    this.main = all.filter((q) => !q.spare);
    /** 备用题，供 host:back 换题，不参与正常出题顺序 */
    this.spares = all.filter((q) => q.spare);
    this.spareCursor = 0;
  }

  get total() {
    return this.main.length;
  }

  /** @param {number} i */
  question(i) {
    return this.main[i];
  }

  /** 是否还有备用题可换 */
  get hasSpare() {
    return this.spareCursor < this.spares.length;
  }

  /**
   * 取下一道备用题。host:back 用它替换掉一道已公布答案的题 ——
   * 原题的答案全场都看过了，重答等于集体送分，只能换题。
   * @returns {{question: object, spareIndex: number}|null}
   */
  takeSpare() {
    if (!this.hasSpare) return null;
    const spareIndex = this.spareCursor++;
    return { question: this.spares[spareIndex], spareIndex };
  }

  /** 重放时恢复备用题游标 */
  restoreSpareCursor(n) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`非法的备用题游标：${n}`);
    this.spareCursor = n;
  }
}

/**
 * 校验题库结构。返回问题列表，空数组表示通过。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function validateBank(raw) {
  const errs = [];
  if (!Array.isArray(raw)) return [`题库必须是数组，实际是 ${typeof raw}`];

  const main = raw.filter((q) => q && !q.spare);
  const spares = raw.filter((q) => q && q.spare);

  if (main.length !== RULES.MAIN_QUESTIONS) {
    errs.push(`正题必须恰好 ${RULES.MAIN_QUESTIONS} 道，实际 ${main.length} 道`);
  }
  if (spares.length < RULES.MIN_SPARE_QUESTIONS) {
    errs.push(
      `备用题至少 ${RULES.MIN_SPARE_QUESTIONS} 道（供 host:back 换题），实际 ${spares.length} 道`,
    );
  }

  raw.forEach((q, i) => {
    const at = `第 ${i + 1} 条${q?.spare ? '（备用）' : ''}`;
    if (!q || typeof q !== 'object') return void errs.push(`${at}：不是对象`);
    if (typeof q.text !== 'string' || q.text.trim() === '') {
      errs.push(`${at}：题干为空`);
    }
    if (!Array.isArray(q.options) || q.options.length < 2) {
      return void errs.push(`${at}：选项至少 2 个，实际 ${q.options?.length ?? 0} 个`);
    }
    q.options.forEach((o, j) => {
      if (typeof o !== 'string' || o.trim() === '') {
        errs.push(`${at}：第 ${j + 1} 个选项为空`);
      }
    });
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) {
      errs.push(`${at}：正确选项下标 ${q.answer} 越界（合法范围 0~${q.options.length - 1}）`);
    }
  });

  return errs;
}

/**
 * 按 QUIZ_BANK 加载题库。
 * @param {{bank?: string, dir?: URL|string}} [opts]
 * @returns {QuizBank}
 */
export function loadBank(opts = {}) {
  const bank = opts.bank ?? process.env.QUIZ_BANK ?? BANK_TEST;
  if (!VALID_BANKS.includes(bank)) {
    throw new Error(`QUIZ_BANK 非法：「${bank}」，只能是 ${VALID_BANKS.join(' 或 ')}`);
  }

  const dir = opts.dir ?? new URL('../questions/', import.meta.url);
  const file = new URL(`${bank}.json`, dir);

  if (!existsSync(file)) {
    // 这里绝不回退。静默回退到 test 意味着婚礼当天用了一整套通用常识题。
    throw new Error(
      `题库文件不存在：${decodeURIComponent(file.pathname)}\n` +
        `  QUIZ_BANK=${bank} 已指定该题库，拒绝回退到 ${BANK_TEST}。\n` +
        `  请确认文件已部署到位后再启动。`,
    );
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`题库解析失败：${decodeURIComponent(file.pathname)}\n  ${e.message}`);
  }

  const errs = validateBank(raw);
  if (errs.length) {
    throw new Error(
      `题库校验未通过：${decodeURIComponent(file.pathname)}\n` +
        errs.map((e) => `  - ${e}`).join('\n'),
    );
  }

  return new QuizBank(bank, raw);
}
