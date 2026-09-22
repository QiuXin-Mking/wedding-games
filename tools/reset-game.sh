#!/usr/bin/env bash
# 重置对局，开新的一场。**在云服务器上运行。**
#
#   /opt/wedding-quiz/reset.sh            交互确认后重置
#   /opt/wedding-quiz/reset.sh -f         跳过确认（脚本/远程调用用）
#   /opt/wedding-quiz/reset.sh --list     只看当前状态和历史归档，不动任何东西
#
# ## 它做什么
#
# 把当前这场的事件日志**归档**到 data/archive/，然后重启服务。
# 服务启动时找不到可续用的日志，就开一场全新的：宾客清零、题号归零、分数清空。
#
# ## 它不删东西
#
# 全程只有 mv，没有 rm。归档后的日志永远留在 data/archive/ 下，
# 想翻旧账随时能翻。婚礼当天误跑一次也不会丢掉已经打出来的成绩 ——
# 这是这个脚本唯一重要的设计决定。
#
# ## 什么时候用
#
# - 彩排完，正式开场前（**必须跑一次**，否则彩排的分数会被当成正式成绩）
# - 试玩了一轮，想重新来过
#
# 婚礼进行中不要跑。

set -euo pipefail

ROOT="/opt/wedding-quiz"
DATA="$ROOT/data"
ARCHIVE="$DATA/archive"
SERVICE="wedding-quiz"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

[ -d "$DATA" ] || { red "找不到 $DATA —— 这个脚本要在云服务器上跑"; exit 1; }

CUR="$(ls -t "$DATA"/*.jsonl 2>/dev/null | head -1 || true)"

# ── 当前状态 ────────────────────────────────────
echo
if [ -z "$CUR" ]; then
  echo "当前：没有进行中的对局（已经是干净状态）"
else
  EVENTS=$(wc -l < "$CUR" | tr -d ' ')
  JOINS=$(grep -c '"type":"join"' "$CUR" || true)
  ANSWERS=$(grep -c '"type":"answer"' "$CUR" || true)
  LAST=$(tail -1 "$CUR" | sed 's/.*"type":"\([^"]*\)".*/\1/')
  STARTED=$(basename "$CUR" .jsonl)
  echo "当前这场："
  echo "  开始于    $STARTED"
  echo "  入场      $JOINS 人"
  echo "  作答      $ANSWERS 次"
  echo "  事件      $EVENTS 条，最后一条是 $LAST"
fi

if [ -d "$ARCHIVE" ]; then
  N=$(ls "$ARCHIVE"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  [ "$N" != "0" ] && dim "已归档 $N 场（$ARCHIVE）"
fi
echo

if [ "${1:-}" = "--list" ]; then
  [ -d "$ARCHIVE" ] && ls -lt "$ARCHIVE" 2>/dev/null | tail -n +2 | awk '{printf "  %s %s %s  %s\n",$6,$7,$8,$9}'
  exit 0
fi

[ -z "$CUR" ] && { echo "无需重置。"; exit 0; }

# ── 确认 ────────────────────────────────────────
if [ "${1:-}" != "-f" ] && [ "${1:-}" != "--force" ]; then
  if [ "$ANSWERS" != "0" ]; then
    red "注意：这场已经有 $ANSWERS 次作答。如果婚礼正在进行，现在重置会让全场从头开始。"
  fi
  printf '确认重置？日志会归档不会删除。输入 yes 继续：'
  read -r ANS
  [ "$ANS" = "yes" ] || { echo "已取消，什么都没动。"; exit 0; }
fi

# ── 归档 + 重启 ─────────────────────────────────
mkdir -p "$ARCHIVE"
mv "$DATA"/*.jsonl "$ARCHIVE"/
chown -R wedding:wedding "$DATA"
systemctl restart "$SERVICE"
sleep 2

echo
echo "已归档：$(basename "$CUR")  →  $ARCHIVE/"
printf '服务：'; systemctl is-active "$SERVICE"
echo "新的一场已就绪：宾客清零、题号归零、分数清空。"
echo
dim "提示：三端浏览器刷新一下即可，静态资源走 ETag，不用强制刷新。"
