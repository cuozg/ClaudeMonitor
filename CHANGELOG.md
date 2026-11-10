# Changelog

## 2.1.0 (2026-11-10)

### Added

- A one-line band above the prompt with the cost, context, running agents and background tasks, and a **Show monitor / Hide monitor** button (CLI and Desktop).

### Changed

- The band button and `/monitor` share one toggle, which checks whether the pane is actually drawn: a pane still waiting for a wider terminal counts as hidden.
- The plugin version is 2.1.0, so installed copies pick up the update.

### Fixed

- The panels no longer touch each other in the Desktop app. The terminal layout is unchanged.

## 2.0.0 (2026-11-10)

The monitor is now a Claude Code mod (plugin `session-monitor`) instead of a Python script.

### Added

- A pane beside the chat in the Claude Code CLI, the Desktop app and the VS Code extension. It opens when a session starts and docks on the right in fullscreen rendering, up to 45% of the terminal.
- `/monitor` to open or close the pane.
- The session's exact cost, as `/cost` shows it, and the context breakdown, as `/context` shows it, read from Claude Code itself.
- Rate limits (5-hour and 7-day windows) in the bill.
- `.claude-plugin/marketplace.json`, so the mod installs with `/plugin install`.
- Tests: `claude plugin test .`

### Changed

- Data comes from Claude Code's events (requests, tool calls, agents, prompts, background task notifications) instead of parsing `~/.claude/projects/*.jsonl`.
- The split of the cost by input, cache write, cache read, output and owner is scaled to the exact total.

### Removed

- The Python dashboard, the tmux `claude` wrapper and the VS Code extension. They are kept in `_v1/` as a backup, with their paths updated to run from there.

## 1.0.0 (2026-11-09)

- The Python terminal dashboard (`claude-monitor.py`), opened next to `claude` by a tmux split or a VS Code extension.
