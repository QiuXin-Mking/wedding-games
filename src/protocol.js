/**
 * 前后端共用的协议常量。
 *
 * 这个文件同时被 Node（服务端）和浏览器（三端页面）import —— 静态托管该路径即可。
 * 这是本项目最重要的一处防重复：消息类型字符串只存在一份，杜绝
 * 「前端发 submitAnswer、后端听 answer」这类联调事故。
 *
 * 规则：任何一端都不得裸写消息字符串，一律从这里取。
 */

/** 角色 */
export const ROLE = Object.freeze({
  GUEST: 'guest',
  SCREEN: 'screen',
  HOST: 'host',
  /** 后台运维页。口令独立于主持人 —— 它能一键清空全场成绩 */
  ADMIN: 'admin',
});

/** 客户端 → 服务端 */
export const C2S = Object.freeze({
  HELLO: 'hello',
  JOIN: 'join',
  ANSWER: 'answer',
  SYNC: 'sync',

  // 主持人动作。全部必须携带 expectedQIndex，服务端据此去重（约束 X-5）
  HOST_START: 'host:start',
  HOST_NEXT: 'host:next',
  HOST_EXTEND: 'host:extend',
  HOST_EARLY_SETTLE: 'host:earlySettle',
  HOST_SKIP: 'host:skip',
  HOST_BACK: 'host:back',
  HOST_REPUBLISH: 'host:republish',
  HOST_PAUSE: 'host:pause',
  HOST_RESUME: 'host:resume',
  HOST_FINISH: 'host:finish',
  HOST_NEXT_NICKNAME: 'host:nextNickname',
  HOST_REMOVE: 'host:remove',
  HOST_SHOW_QR: 'host:showQr',
  /** 按需拉宾客列表。不塞进 hostState —— 400 人 × 每次作答会推出几 MB 无谓流量 */
  HOST_GUESTS: 'host:guests',
  /** 发奖时点名：让该宾客的手机全屏亮起「叫的就是您」。
      随机昵称切断了名字与真人的联系，光靠主持人念、宾客举手认领并不可靠 ——
      嘈杂环境里听错、或者不敢举手怕认错，都会让发奖环节冷场。 */
  HOST_CALL: 'host:call',
  /** 颁奖结束后，把鸣谢打到大屏上：活动策划与技术支持的微信码 */
  HOST_CREDITS: 'host:credits',

  /** 后台：清空全部状态重新开始，可同时切换题库。带 bank 就换库，不带就只重来 */
  ADMIN_RESET: 'admin:reset',
});

/**
 * 需要 expectedQIndex 去重的主持人动作。
 *
 * 注意：去重只对**会改变题号**的动作真正生效（next / back）。
 * extend / republish / showQr 这类不改题号的动作，双击仍会执行两次
 * —— 双击「延长 10 秒」就是 +20 秒。这是已知的，主持人手册里说明即可，
 * 不值得为此引入操作序号。
 */
export const HOST_ACTIONS_NEEDING_QINDEX = Object.freeze([
  C2S.HOST_NEXT,
  C2S.HOST_EXTEND,
  C2S.HOST_EARLY_SETTLE,
  C2S.HOST_SKIP,
  C2S.HOST_BACK,
  C2S.HOST_REPUBLISH,
  C2S.HOST_PAUSE,
  C2S.HOST_RESUME,
]);

/** 服务端 → 客户端 */
export const S2C = Object.freeze({
  SNAPSHOT: 'snapshot',
  IDENTITY: 'identity',
  QUESTION: 'question',
  /** 答案回执。前端收到才可显示「已提交」（约束 X-2） */
  ANSWER_ACK: 'answerAck',
  /** 面向宾客的公告，每个救场动作都要带一句人话（约束 X-4） */
  NOTICE: 'notice',
  PROGRESS: 'progress',
  REVEAL: 'reveal',
  MY_RESULT: 'myResult',
  FINAL: 'final',
  MY_FINAL: 'myFinal',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  /** 主持人专用：题干/答案 + 唱分四项 + 时间预算 + 连接状态 */
  HOST_STATE: 'hostState',
  /** 主持人按需拉到的宾客列表 */
  GUEST_LIST: 'guestList',
  /** 让大屏重新打出入口二维码，给迟到的人扫 */
  SHOW_QR: 'qr',
  /** 发奖点名：只发给被叫到的那一位 */
  CALLED: 'called',
  /** 大屏切换鸣谢画面。on=false 收起 */
  CREDITS: 'credits',
  /** 后台页要看到的东西：当前题库、阶段、这一局已经累积了多少数据 */
  ADMIN_STATE: 'adminState',
  REJECTED: 'rejected',
  PONG: 'pong',
});

/** 游戏阶段 */
export const STAGE = Object.freeze({
  IDLE: 'IDLE',
  READY: 'READY',
  ASKING: 'ASKING',
  PAUSED: 'PAUSED',
  REVEAL: 'REVEAL',
  FINAL: 'FINAL',
});

/** 单题作答结果 */
export const OUTCOME = Object.freeze({
  CORRECT: 'correct',
  WRONG: 'wrong',
  /** 到截止仍未提交 */
  TIMEOUT: 'timeout',
  /** 主持人跳过或换备用题，全员 0 分且不计入累计耗时 */
  SKIPPED: 'skipped',
});

/** 拒绝原因 */
export const REJECT = Object.freeze({
  BAD_KEY: 'badKey',
  GAME_FINISHED: 'gameFinished',
  NOT_ASKING: 'notAsking',
  PAUSED: 'paused',
  DEADLINE_PASSED: 'deadlinePassed',
  STALE_ACTION: 'staleAction',
  ILLEGAL_TRANSITION: 'illegalTransition',
  UNKNOWN_GUEST: 'unknownGuest',
  /** join 缺 clientId 或角色不对。必须回执 —— 宾客端的「进入」按钮在等它解锁 */
  BAD_JOIN: 'badJoin',
});

/** notice 的种类，决定宾客端展示什么文案 */
export const NOTICE = Object.freeze({
  EXTENDED: 'extended',
  SKIPPED: 'skipped',
  SWAPPED: 'swapped',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  RECOVERED: 'recovered',
});

/** 游戏参数。改这里等于改产品规则，须同步 docs/01。 */
export const RULES = Object.freeze({
  /** 每题作答时长（毫秒） */
  QUESTION_MS: 20_000,
  /** host:extend 每次延长的时长（毫秒）。只延后结算，不改计分基准 */
  EXTEND_MS: 10_000,
  /** 答对的基础分 */
  BASE_SCORE: 100,
  /** 每剩余整秒的加成 */
  SPEED_BONUS_PER_SEC: 10,
  /** 正题数量 */
  MAIN_QUESTIONS: 13,
  /** 备用题数量下限 */
  MIN_SPARE_QUESTIONS: 1,
  /** 昵称池容量 */
  NICKNAME_POOL_SIZE: 400,
});

/**
 * 单题得分。
 *
 * remainMs 必须由调用方用「**原始**截止时刻 − 服务端收到答案的时刻」算出。
 * host:extend 只延后 deadlineAt（何时结算），不改 originalDeadlineAt（如何计分），
 * 所以延长期间提交的答案 remainMs <= 0，一律 0 分 —— 这消除了「答得越慢分越高」。
 *
 * @param {boolean} correct
 * @param {number} remainMs
 * @returns {number}
 */
export function scoreOf(correct, remainMs) {
  if (!correct) return 0;
  if (remainMs <= 0) return 0;
  return RULES.BASE_SCORE + Math.floor(remainMs / 1000) * RULES.SPEED_BONUS_PER_SEC;
}
