#!/usr/bin/env bash
# 一键发布 / 回滚（FR-9.2）。
#
#   tools/deploy.sh                 发布当前代码
#   tools/deploy.sh --rollback      回滚到上一个版本
#   tools/deploy.sh --list          列出服务器上的版本
#
# 发布是「解包到新目录 → 装依赖 → 切软链 → 重启」，
# 回滚只是把软链切回去再重启 —— 5 秒完成，且 data/ 不受影响。
#
# 10/3 代码冻结之后，当天万一必须改，回滚比重新部署安全得多。

set -euo pipefail

HOST="${WQ_HOST:-root@119.29.186.63}"
ROOT="/opt/wedding-quiz"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "✗ $*" >&2; exit 1; }

case "${1:-deploy}" in
  --list)
    ssh "$HOST" "ls -t $ROOT/releases | head -10 | sed 's/^/  /'; echo; echo -n '  当前: '; basename \$(readlink $ROOT/current)"
    ;;

  --rollback)
    ssh "$HOST" "
      set -e
      CUR=\$(basename \$(readlink $ROOT/current))
      PREV=\$(ls -t $ROOT/releases | grep -v \"^\$CUR\$\" | head -1)
      [ -n \"\$PREV\" ] || { echo '✗ 没有可回滚的版本'; exit 1; }
      ln -sfn $ROOT/releases/\$PREV $ROOT/current
      systemctl restart wedding-quiz
      sleep 2
      echo \"  \$CUR → \$PREV\"
      echo -n '  服务: '; systemctl is-active wedding-quiz
      echo '  data/ 未受影响，比赛数据完整保留'
    "
    ;;

  deploy)
    # 本地先自检，不把坏东西发上去
    echo "→ 本地自检"
    cd "$SELF"
    npm test >/dev/null 2>&1 || die "测试未通过，拒绝发布"
    node tools/check-nicknames.js >/dev/null 2>&1 || die "昵称池校验未通过，拒绝发布"
    echo "  测试与昵称池校验通过"

    # 刷新预压缩产物。峰值时 CPU 要留给 WebSocket，不能运行时压缩
    node -e '
      const {readFileSync,writeFileSync}=require("fs"),{gzipSync}=require("zlib");
      for(const f of ["public/index.html","public/screen.html","public/host.html","public/guide.html","public/how.html","src/protocol.js"])
        writeFileSync(f+".gz",gzipSync(readFileSync(f),{level:9}));
    '
    echo "  预压缩已刷新"

    TGZ=$(mktemp -u /tmp/wq-XXXXXX.tgz)
    tar czf "$TGZ" --exclude=node_modules --exclude=.git --exclude=data --exclude=wip .
    scp -q "$TGZ" "$HOST:/tmp/wq-deploy.tgz"
    rm -f "$TGZ"
    echo "→ 已上传"

    ssh "$HOST" "
      set -e
      S=\$(date +%Y%m%d-%H%M%S)
      mkdir -p $ROOT/releases/\$S $ROOT/data
      tar xzf /tmp/wq-deploy.tgz -C $ROOT/releases/\$S
      cd $ROOT/releases/\$S && npm install --omit=dev --silent
      ln -sfn $ROOT/releases/\$S $ROOT/current
      # 重置脚本装到固定路径，不随版本漂移 —— 当天要用的东西，路径必须是死的
      install -m 755 $ROOT/releases/\$S/tools/reset-game.sh $ROOT/reset.sh
      chown -R wedding:wedding $ROOT
      systemctl restart wedding-quiz
      sleep 2
      echo \"  发布 \$S\"
      echo -n '  服务: '; systemctl is-active wedding-quiz
      echo -n '  依赖: '; ls $ROOT/current/node_modules | grep -v '^\\.' | tr '\\n' ' '; echo
      # 只保留最近 5 个版本，别把盘撑满
      ls -t $ROOT/releases | tail -n +6 | xargs -r -I{} rm -rf $ROOT/releases/{}
    "

    echo "→ 冒烟"
    HOSTNAME_ONLY="${HOST#*@}"
    for p in / "/screen" "/host"; do
      CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://$HOSTNAME_ONLY:8888$p")
      [ "$CODE" = "200" ] || die "$p 返回 $CODE"
      printf "  %-8s %s\n" "$p" "$CODE"
    done
    echo
    echo "✓ 发布完成"
    echo "  静态资源走 ETag 协商缓存，刷新即生效，无需强制刷新"
    ;;

  *)
    die "未知参数：$1（可用：--list / --rollback，或不带参数发布）"
    ;;
esac
