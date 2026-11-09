const vscode = require('vscode');
const os = require('os');
const path = require('path');

const RUN = path.join(os.homedir(), '.claude', 'monitor', 'monitor-run.sh');
// Same rules as ~/.claude/monitor/claude-monitor.zsh: only interactive sessions get a monitor.
const SKIP_SUB = new Set(['agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp',
  'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade']);
const SKIP_FLAG = new Set(['-p', '--print', '-v', '--version', '-h', '--help', '--bg']);

const monitors = new Map(); // claude terminal -> monitor terminal

function isInteractiveClaude(line) {
  const args = line.trim().split(/\s+/);
  return args[0] === 'claude' && !SKIP_SUB.has(args[1]) && !args.some(a => SKIP_FLAG.has(a));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openMonitor(cwd, viewColumn = vscode.ViewColumn.Beside) {
  const term = vscode.window.createTerminal({
    name: 'Claude Monitor',
    shellPath: RUN,
    shellArgs: [cwd],
    cwd,
    isTransient: true,
    location: { viewColumn, preserveFocus: true },
  });
  await sleep(300);
  // Left group 1/3, monitor 2/3 — only when it's a plain two-group split, so other layouts are untouched.
  if (vscode.window.tabGroups.all.length === 2) {
    await vscode.commands.executeCommand('vscode.setEditorLayout',
      { orientation: 0, groups: [{ size: 1 / 3 }, { size: 2 / 3 }] });
  }
  return term;
}

function closeFor(claudeTerm) {
  const m = monitors.get(claudeTerm);
  if (m) { monitors.delete(claudeTerm); m.dispose(); }
}

const wsCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

// Claude Code VSCode extension opened as an editor tab (claudeCode.preferredLocation: "panel").
// One monitor while any Claude tab is open; closed by hand = stays closed until all Claude tabs close.
const PANEL = 'claude-panel';
let panelDismissed = false;

function claudeTab() {
  for (const g of vscode.window.tabGroups.all)
    for (const t of g.tabs)
      if (t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('claudeVSCodePanel')) return t;
}

async function syncPanel() {
  const tab = claudeTab();
  if (!tab) { panelDismissed = false; closeFor(PANEL); return; }
  if (monitors.has(PANEL) || panelDismissed) return;
  monitors.set(PANEL, null);
  const m = await openMonitor(wsCwd(), tab.group.viewColumn + 1);
  if (monitors.has(PANEL)) monitors.set(PANEL, m); else m.dispose();
}

function activate(context) {
  syncPanel();
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(syncPanel),
    vscode.window.onDidStartTerminalShellExecution(async e => {
      if (monitors.has(e.terminal) || !isInteractiveClaude(e.execution.commandLine.value)) return;
      const cwd = (e.execution.cwd || e.terminal.shellIntegration?.cwd)?.fsPath
        || wsCwd();
      monitors.set(e.terminal, null);
      const m = await openMonitor(cwd);
      if (monitors.has(e.terminal)) monitors.set(e.terminal, m); else m.dispose();
    }),
    vscode.window.onDidEndTerminalShellExecution(e => closeFor(e.terminal)),
    vscode.window.onDidCloseTerminal(t => {
      closeFor(t);
      for (const [k, m] of monitors) if (m === t) { monitors.delete(k); if (k === PANEL) panelDismissed = true; }
    }),
    vscode.commands.registerCommand('claudeMonitor.open', () => openMonitor(wsCwd())),
  );
}

module.exports = { activate, deactivate() {} };
