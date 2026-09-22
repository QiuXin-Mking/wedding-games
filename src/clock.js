/**
 * 服务端单调时钟。
 *
 * 进程内所有时间判断（deadlineAt、答题耗时、计分）一律用 now()，
 * **绝不直接用 Date.now()**。
 *
 * 原因：Date.now() 取的是墙钟，服务器 NTP 校时会让它向前或向后跳。
 * 答题中跳一下，倒计时就错乱，分数也跟着错。hrtime 是单调的，不受校时影响。
 *
 * 事件日志的 ts 字段仍用 wallNow()，那是给人看的绝对时间，需要真实墙钟。
 */

const BOOT_WALL = Date.now();
const BOOT_HR = process.hrtime.bigint();

/**
 * 单调推进的「墙钟风格」毫秒时间戳。
 * 数值上接近 Date.now()，但只会单调递增，不受 NTP 校时影响。
 * @returns {number}
 */
export function now() {
  return BOOT_WALL + Number(process.hrtime.bigint() - BOOT_HR) / 1e6;
}

/**
 * 真实墙钟，仅用于写进事件日志给人看。
 * @returns {number}
 */
export function wallNow() {
  return Date.now();
}
