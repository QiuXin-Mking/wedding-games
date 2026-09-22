/**
 * 昵称发放（docs/01 §3.3）。
 *
 * 宾客不可自填昵称。服务端从一个 400 条人工定稿的常量池**按序**发放：
 * 发放顺序在生成期就已定死（数组顺序即发放顺序），**运行时零随机** ——
 * 不洗牌、不查重、不重试。第 N 位入场的宾客拿第 N 条。
 *
 * 这样做的收益：数学上零重复；崩溃恢复只需要一个整数；
 * 同样的入场顺序必然得到同样的分配，彩排与正式场行为完全一致。
 */

import { readFileSync } from 'node:fs';
import { RULES } from './protocol.js';
import { validatePool } from './nicknameRules.js';

export class NicknamePool {
  /**
   * @param {string[]} pool 顺序即发放顺序
   */
  constructor(pool) {
    this.pool = pool;
    this.cursor = 0;
  }

  /**
   * 从磁盘加载并校验。校验不过直接抛错 —— 绝不带着坏池子启动。
   * @param {string} file
   * @returns {NicknamePool}
   */
  static load(file) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`昵称池读取失败：${file}\n  ${e.message}`);
    }
    const report = validatePool(raw);
    if (!report.ok) {
      const failed = report.checks
        .filter((c) => !c.ok)
        .map((c) => `  [${c.id}] ${c.desc} —— ${c.detail}`)
        .join('\n');
      throw new Error(`昵称池校验未通过：${file}\n${failed}`);
    }
    return new NicknamePool(raw);
  }

  /** 已发放数量 */
  get issued() {
    return this.cursor;
  }

  /** 池是否已耗尽（第 401 位起进入兜底命名） */
  get exhausted() {
    return this.cursor >= this.pool.length;
  }

  /**
   * 发放下一个昵称。
   *
   * 超出池容量后降级为「池内昵称 + 空格 + 序号」。用户已确认现场不超过 400 人，
   * 此路径为纯兜底，不应被触发 —— 触发时调用方须打告警日志。
   * @returns {{nickname: string, cursor: number, fallback: boolean}}
   */
  issue() {
    const i = this.cursor++;
    if (i < this.pool.length) {
      return { nickname: this.pool[i], cursor: i, fallback: false };
    }
    const base = this.pool[i % this.pool.length];
    return { nickname: `${base} ${i + 1}`, cursor: i, fallback: true };
  }

  /**
   * 从事件日志重放游标。
   *
   * 游标不单独持久化 —— 它是 guest_join 事件的副产物。重放后必须保证
   * 下一位新宾客拿到的是第 N+1 条，绝不把同一昵称分给第二个人。
   * @param {number} cursor 已发放数量
   */
  restore(cursor) {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error(`非法的昵称游标：${cursor}`);
    }
    this.cursor = cursor;
  }
}

/** 默认池文件路径下的便捷加载 */
export function loadDefaultPool(file = new URL('../nicknames.json', import.meta.url)) {
  return NicknamePool.load(file);
}

export { RULES };
