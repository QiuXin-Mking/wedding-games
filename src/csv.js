/**
 * 明细导出（docs/01 §5.3，AC-32）。
 *
 * 手写拼接，约 30 行。C6 禁止为这点事引一个 csv 库。
 *
 * 必须带 UTF-8 BOM：不带的话 Excel 在中文 Windows 上会按 GBK 解释，
 * 整张表的中文全是乱码 —— 而这张表是婚礼结束后唯一的成绩凭据。
 */

import { OUTCOME } from './protocol.js';

const BOM = '﻿';

const OUTCOME_CN = Object.freeze({
  [OUTCOME.CORRECT]: '答对',
  [OUTCOME.WRONG]: '答错',
  [OUTCOME.TIMEOUT]: '未作答',
  [OUTCOME.SKIPPED]: '本题作废',
});

/** 转义一个单元格。含逗号、引号、换行时必须加引号 */
function cell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 导出「每位宾客 × 每道题」的明细。
 * 行数 = 宾客数 × 题数（AC-32）。
 *
 * @param {import('./game.js').Game} game
 * @returns {string}
 */
export function exportDetailCsv(game) {
  const header = [
    '昵称', '题号', '题干', '所选选项', '正确选项', '结果', '本题得分', '作答耗时(秒)',
    '总分', '答对题数', '最终名次',
  ];
  const board = game.leaderboard();
  const rankOf = new Map(board.map((r) => [r.clientId, r]));

  const rows = [header.map(cell).join(',')];

  for (const row of board) {
    const g = game.guests.get(row.clientId);
    const summary = rankOf.get(row.clientId);
    for (let q = 0; q < game.totalQuestions; q++) {
      const question = game.overrides.get(q) ?? game.bank.question(q);
      const a = g.answers.get(q);
      rows.push([
        g.nickname,
        q + 1,
        question?.text ?? '',
        // -1 表示没选（未作答或本题作废）
        a && a.optionIndex >= 0 ? question?.options[a.optionIndex] ?? '' : '',
        game.voided.has(q) ? '（本题作废）' : question?.options[question?.answer] ?? '',
        a ? OUTCOME_CN[a.outcome] ?? a.outcome : '未作答',
        a?.gained ?? 0,
        a ? (a.elapsedMs / 1000).toFixed(1) : '',
        summary.total,
        summary.correctCount,
        summary.rank,
      ].map(cell).join(','));
    }
  }

  return BOM + rows.join('\r\n') + '\r\n';
}
