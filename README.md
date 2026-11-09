# Claude Monitor

A live terminal dashboard for [Claude Code](https://claude.com/claude-code). It reads the session logs Claude Code writes to `~/.claude/projects/` and shows, for the latest session of a project, what it costs, how full the context is, and what every subagent and background task is doing.

Run `claude` and the monitor opens next to it automatically: through a tmux split in a regular terminal, or through a small extension in VSCode.

## Core features

- **The bill**: live session cost split into input, cache write, cache read and output, with per-model pricing (Opus, Sonnet, Haiku, Fable) and cost share per agent.
- **Context window**: tokens used against the auto-compaction window, broken down by system prompt, tools, MCP tools, skills, agents, memory files and messages. Respects `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
- **Agent team view**: each subagent with its model, state (running, done, failed, stalled), current tool, cost and a flow diagram from the main session.
- **Background tasks**: running and finished bash tasks, with the last line of their output and exit codes.
- **Timeline and log**: per-agent activity lanes and recent tool calls.
- **Alerts**: stalled agents (no activity for 3 minutes), failed agents or tasks, and context above 80% / 90% of the compaction window.
- **Adaptive layout**: the frame shrinks or drops sections to fit the terminal size.
- **Auto-split**: `claude` opens Claude Code on the left third and the monitor on the right two thirds, in tmux or VSCode.

## Requirements

- macOS or Linux
- Python 3 (standard library only)
- Claude Code
- zsh and tmux for the terminal auto-split
- VSCode 1.93+ for the VSCode auto-split

## Setup

The scripts expect this repo at `~/.claude/monitor`.

```sh
git clone git@github.com:cuozg/ClaudeMonitor.git ~/.claude/monitor
chmod +x ~/.claude/monitor/monitor-run.sh ~/.claude/monitor/claude-monitor.py
```

### Terminal (zsh + tmux)

Add to `~/.zshrc`:

```sh
source ~/.claude/monitor/claude-monitor.zsh
alias claude-monitor="python3 ~/.claude/monitor/claude-monitor.py"
```

Open a new shell. From then on, `claude` starts in a dedicated tmux session with the monitor on the right. The session closes when Claude Code exits.

The split is skipped for non-interactive uses such as `claude -p`, `claude --version` and `claude mcp ...`. To skip it yourself:

```sh
CLAUDE_NO_MONITOR=1 claude    # skip once
command claude                # call the plain binary
```

### VSCode

Install the bundled extension:

```sh
code --install-extension ~/.claude/monitor/vscode/claude-monitor.vsix
```

The monitor then opens beside the editor (two thirds of the width) when:

- you run `claude` in a VSCode terminal (requires shell integration, which is on by default), or
- the Claude Code extension is opened as an editor tab.

You can also open it by hand with the command palette: **Claude Monitor: Open**.

## Usage

```sh
claude-monitor                    # one snapshot for the current directory
claude-monitor -w                 # live mode, refreshes every second
claude-monitor /path/to/project -w
```

The project must have at least one Claude Code session. In live mode, `monitor-run.sh` retries every 2 seconds until the first session log appears. Press `Ctrl+C` to quit.

## Files

| File | Purpose |
| --- | --- |
| `claude-monitor.py` | The dashboard |
| `monitor-run.sh` | Starts the dashboard in live mode, retrying until a session exists |
| `claude-monitor.zsh` | `claude` wrapper that creates the tmux split |
| `tmux.conf` | Config for the dedicated tmux server (`tmux -L claude`) |
| `vscode/` | VSCode extension source and packaged `.vsix` |
