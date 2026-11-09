# `claude` = Claude Code + claude-monitor.py on the right 2/3 (tmux split).
# Inside VSCode the "Claude Monitor" extension does the split instead.
# Opt out once: CLAUDE_NO_MONITOR=1 claude ...   |  bypass: command claude ...
_claude_monitor_wanted() {
  [[ -z $CLAUDE_NO_MONITOR && -t 0 && -t 1 ]] || return 1
  case "$1" in
    agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade) return 1 ;;
  esac
  local a
  for a in "$@"; do
    case "$a" in -p|--print|-v|--version|-h|--help|--bg) return 1 ;; esac
  done
}

claude() {
  local bin=${commands[claude]}
  if [[ -z $TMUX && $TERM_PROGRAM != vscode && -n $bin ]] && (( $+commands[tmux] )) && _claude_monitor_wanted "$@"; then
    local s="claude-$$-$RANDOM" d=$HOME/.claude/monitor
    local t=(tmux -L claude -f $d/tmux.conf)
    $t new-session -d -s $s -c "$PWD" -x $COLUMNS -y $LINES \
      "${(q)bin} ${(j: :)${(q)@}}; tmux -L claude kill-session -t $s" || { command claude "$@"; return }
    $t split-window -d -h -l 50% -t $s -c "$PWD" "${(q)d}/monitor-run.sh ${(q)PWD}"
    $t attach -t $s
  else
    command claude "$@"
  fi
}
