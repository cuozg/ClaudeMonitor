# Changelog

## Unreleased

### Fixed

- On Desktop and VS Code both halves of the pane scroll again: a row with a ▸ / ▾ button draws about two text rows tall there, and the halves now count it so, instead of overflowing with nothing to scroll.
- Rows no longer squeeze into garbled lines when a half is full: each keeps its height and the half clips at its bottom edge.
- A multi-line agent label, step or report stays on one row instead of breaking the subagents half.

## 2.3.0 (2026-11-15)

### Added

- **Agent flow**: subagents share the monitor pane: subagents on the left and the monitor on the right at a fixed 50 columns when the pane is 81+ columns wide, and a wider pane widens only the subagents, else the monitor on top and the subagents below. The halves scroll apart: the wheel scrolls the half under it, and the scroll keys scroll the subagents (or the monitor when they are hidden). Each subagent is its own section: a header row (state, label, model, type, context size and %, cost, elapsed time) and the timeline of its latest 8 steps (time, tool, target, lines changed or duration, errors), plus its report once finished. A hairline separates one subagent from the next. The half always shows, with **No agents yet** before the first subagent.
- A **Hide agents / Show agents** button in the band above the prompt toggles the subagents half (and opens the pane when it is closed).
- **Hide monitor** in the band hides only the monitor half: the pane stays open with the subagents alone. The pane closes once neither half has anything to show. `/monitor` still opens or closes the whole pane.
- Each monitor section (Needs attention, Cost, Context, Token, Model, Skills, Plugins, MCP, Tools, Monitor, Background tasks) has a ▸ / ▾ button: Cost and Context start open, the rest start collapsed to their title row and headline figure, and each toggles on a click. The choice is kept for the session. Every section always shows, even with no data; an empty one opens to **none**.
- The monitor scrolls: nothing is cut to fit any more. Token, Model, Skills, Plugins, MCP, Tools and the task lists show every row instead of the first few with **+N more**.
- A **Tools** section below **MCP** lists every tool called (Bash, Read, Skill, mcp__…), with the tokens and cost of the requests that read its result, like the Skills, Plugins and MCP sections.

### Fixed

- Background agent tasks no longer stay **running** after their agents finish: each second the monitor checks the engine's agent list and ends the task of an agent that completed, failed, was stopped, or is no longer listed, even when no SubagentStop or task notification arrived.

### Changed

- The **Activity** log is gone from the monitor; background tasks take the rows it used.
- A line separates the monitor and the subagents halves: a horizontal line when they are stacked, a vertical one when they sit side by side.
- The monitor is one column at most 100 wide: the cost block sits above the context block, and a wider pane gives the extra columns to the subagents only.
- **Hide monitor** keeps the pane open on the agents half even before the first subagent.
- The band above the prompt no longer shows alerts; they stay in the pane's **Needs attention** box.
- Every row of the pane ends flush at the section's right edge: the two top columns fill the full width, and the rate-limit, context and subagent rows no longer fall a cell short or long.
- A blank line separates every section of the pane.
- **Context** matches the app's own list: the deferred MCP and system tools are rows of their own, and memory files no longer nest under it.
- **Cost** drops the model rates line and the burn sparkline; the burn rate stays as a figure.

## 2.2.0 (2026-11-10)

### Added

- A **Needs attention** box at the top of the pane, shown only when something needs a look: failed or stalled agents, failed tasks, a nearly full context, a rate limit at 80%+, a burn rate above $20/h, repeated tool errors, or a long-running main tool call.
- The band above the prompt shows the alert (or the alert count) in red or gold.

### Changed

- The pane is compact and every figure shows once: the cost total, cache hit rate, model and rates, context size and agent counts no longer repeat across panels.
- The header is one line: state, path with the project highlighted, session and clock. Its LIVE / IDLE pill follows the main session's state, so it no longer says LIVE for 15 seconds after a turn ends.
- The four token cards are rows in the **Cost** panel; the main / agents split shows only when there are agents.
- In **Context**, memory files nest under their category and the deferred MCP tool count joins its row.
- Empty agent and task panels collapse into one line; the timeline shows only once there are agents.
- The log is **Activity**, without the tag column.

### Removed

- The model legend, the team line, the **Who sees what** panel (the agent table has the tokens) and the status line (the band above the prompt shows the same).

## 2.1.1 (2026-11-10)

### Fixed

- In the CLI the pane no longer has a gray fill of its own: it draws on the terminal's background. Desktop and VS Code are unchanged.

### Docs

- The README shows screenshots of the pane and the band.

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
