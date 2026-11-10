#!/usr/bin/env python3
"""Claude Code Live Monitor - cost / context / agent-team dashboard for the latest session of a project.

Usage: claude-monitor.py [project_path] [-w | --watch]
"""
import os
import sys
import json
import time
import re
import shutil
import unicodedata
from pathlib import Path
from datetime import datetime

# ── ANSI ──────────────────────────────────────────────────────────────────────
ESC = "\033["
RESET = ESC + "0m"
BOLD = ESC + "1m"
DIM = ESC + "2m"
ITALIC = ESC + "3m"
STRIKE = ESC + "9m"


def fg(n):
    return "{}38;5;{}m".format(ESC, n)


def bg(n):
    return "{}48;5;{}m".format(ESC, n)


C_PURPLE = fg(141)
C_GREEN = fg(114)
C_ORANGE = fg(209)
C_BLUE = fg(75)
C_GOLD = fg(221)
C_PINK = fg(212)
C_CYAN = fg(80)
C_RED = fg(203)
C_WHITE = fg(255)
C_LIGHT = fg(250)
C_GRAY = fg(245)
C_DARK = fg(240)
C_TRACK = fg(237)
C_FRAME = fg(238)
BG_HL = bg(236)

HOME = ESC + "H"
CLR_EOL = ESC + "K"
CLR_EOS = ESC + "J"
HIDE_CURSOR = ESC + "?25l"
SHOW_CURSOR = ESC + "?25h"
ALT_ON = ESC + "?1049h"
ALT_OFF = ESC + "?1049l"

SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
PIE = "◐◓◑◒"
SPARK = "▁▂▃▄▅▆▇█"
LANE_COLORS = [C_ORANGE, C_BLUE, C_GREEN, C_PINK, C_CYAN, C_GOLD]
FAMILY_COLORS = {"opus": C_PURPLE, "sonnet": C_ORANGE, "haiku": C_BLUE, "fable": C_GOLD, "mythos": C_GOLD}

STALL_SECS = 180            # running agent with no log write and no tool in flight
AUTOCOMPACT_BUFFER = 33_000  # reserved by Claude Code before auto-compaction

# ── Pricing ($ / MTok): (input, output, cache_read or None = 10% of input) ────
# Cache write: 5m = 1.25x input, 1h = 2x input. Fast mode = 2x.
# Opus 5.5 & Sonnet 5.5 values reproduce Claude Code's own cost-state exactly.
PRICES = {
    "fable-5-1": (10.0, 50.0, 0.25), "mythos-5-1": (10.0, 50.0, 0.25), "fable-5": (10.0, 50.0, None),
    "opus-5-5": (4.0, 20.0, 0.20), "opus-5": (5.0, 25.0, None), "opus-4": (5.0, 25.0, None),
    "sonnet-5-5": (2.0, 10.0, 0.10), "sonnet-5": (2.0, 10.0, None), "sonnet-4": (3.0, 15.0, None),
    "haiku-5-5": (0.10, 0.50, None), "haiku-4": (1.0, 5.0, None),
}
MODEL_RE = re.compile(r'(opus|sonnet|haiku|fable|mythos)((?:-\d{1,2}(?!\d))*)')
CATS = ("in", "cw", "cr", "out")


def rates(model):
    """-> (input, output, cache_read, cache_write_5m, cache_write_1h) $/MTok"""
    m = MODEL_RE.search(model or "")
    p = None
    if m:
        key = m.group(1) + m.group(2)
        while key:
            if key in PRICES:
                p = PRICES[key]
                break
            if "-" not in key:
                break
            key = key.rsplit("-", 1)[0]
    i, o, cr = p or PRICES["opus-5-5"]
    return i, o, (cr if cr is not None else i * 0.1), i * 1.25, i * 2.0


def pretty_model(model):
    m = MODEL_RE.search(model or "")
    if not m:
        return model or "—"
    ver = ".".join(x for x in m.group(2).split("-") if x)
    return (m.group(1).capitalize() + " " + ver).strip()


def model_color(model):
    m = MODEL_RE.search(model or "")
    return FAMILY_COLORS.get(m.group(1), C_CYAN) if m else C_CYAN


# ── Text helpers ──────────────────────────────────────────────────────────────
ANSI_RE = re.compile(r'\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])')


def strip_ansi(text):
    return ANSI_RE.sub('', text)


def cwidth(ch):
    if unicodedata.combining(ch) or ch in "​‍️":
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def vlen(text):
    return sum(cwidth(ch) for ch in strip_ansi(text))


def fit(plain, w):
    """Truncate plain (uncolored) text to display width w."""
    plain = "".join(ch if ch.isprintable() else " " for ch in strip_ansi(str(plain)))
    if w <= 0:
        return ""
    if vlen(plain) <= w:
        return plain
    out, n = [], 0
    for ch in plain:
        if n + cwidth(ch) > w - 1:
            break
        out.append(ch)
        n += cwidth(ch)
    return "".join(out) + "…"


def pad(text, w, align="<"):
    gap = max(0, w - vlen(text))
    if align == "^":
        return " " * (gap // 2) + text + " " * (gap - gap // 2)
    if align == ">":
        return " " * gap + text
    return text + " " * gap


def spread(left, right, w):
    return left + " " * max(1, w - vlen(left) - vlen(right)) + right


def c(color, text):
    return color + text + RESET


def pill(label, bg_n, w=7, fg_n=16):
    return bg(bg_n) + fg(fg_n) + BOLD + pad(label, w, "^") + RESET


def fmt_tok(n):
    if n >= 1_000_000:
        return "{:.2f}M".format(n / 1_000_000)
    if n >= 1_000:
        return "{:.0f}k".format(n / 1_000) if n >= 100_000 else "{:.1f}k".format(n / 1_000)
    return str(int(n))


def fmt_cost(x):
    return "<$0.01" if 0 < x < 0.01 else "${:.2f}".format(x)


def fmt_rate(x):
    if x == int(x):
        return "${}".format(int(x))
    s = "{:.3f}".format(x).rstrip("0")
    return "$" + (s + "0" if len(s.split(".")[1]) < 2 else s)


def fmt_duration(seconds):
    s = int(max(0, seconds))
    if s < 60:
        return "{}s".format(s)
    m, s = divmod(s, 60)
    if m < 60:
        return "{}m {:02d}s".format(m, s)
    h, m = divmod(m, 60)
    return "{}h {:02d}m".format(h, m)


def parse_iso(ts_str):
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def hhmmss(ts):
    return datetime.fromtimestamp(ts).strftime("%H:%M:%S") if ts else "--:--:--"


def bar(frac, w, color):
    frac = max(0.0, min(1.0, frac))
    eighths = int(round(frac * w * 8))
    full, rem = divmod(eighths, 8)
    s = "█" * full + ("▏▎▍▌▋▊▉"[rem - 1] if rem else "")
    return color + s + C_TRACK + "█" * max(0, w - vlen(s)) + RESET


def sparkline(values, color):
    top = max(values) if values else 0
    if top <= 0:
        return c(C_TRACK, SPARK[0] * len(values))
    return "".join(c(color, SPARK[min(7, int(v / top * 7.999))]) if v > 0 else c(C_TRACK, SPARK[0]) for v in values)


def first_line(text, limit=200):
    for ln in str(text).splitlines():
        ln = ln.strip().strip("*#>`").strip()
        if ln:
            return ln[:limit]
    return ""


def summary_line(text, limit=200):
    """Most informative line of a message: a STATUS line, else the first substantial line."""
    text = str(text).split("The report follows:", 1)[-1]
    keys = dict((m.group(1).upper(), m.group(2).strip().strip('"'))
                for m in re.finditer(r'(?m)^\s{0,4}([A-Za-z_]{3,20}):[ \t]*(.*)$', text))
    if keys.get("STATUS") and len(keys) >= 3:          # structured (YAML-style) hand-back
        bits = [keys["STATUS"]]
        files = keys.get("FILES_CHANGED", "")
        if files.startswith("["):
            n = len([x for x in files.strip("[]").split(",") if x.strip()])
            bits.append("{} file{}".format(n, "" if n == 1 else "s"))
        if keys.get("ATTEMPTS"):
            bits.append("attempts " + keys["ATTEMPTS"])
        for k in ("SUMMARY", "RESULT", "ROOT_CAUSE", "VERDICT", "NOTE", "BLOCKER", "REASON"):
            if keys.get(k):
                bits.append(k.lower().replace("_", " ") + ": " + keys[k])
                break
        return " · ".join(bits)[:limit]
    lines = [ln.strip() for ln in text.splitlines() if not ln.strip().startswith("```")]
    lines = [ln.replace("**", "").strip("*#>`- ").strip() for ln in lines]
    lines = [ln for ln in lines if ln]
    for i, ln in enumerate(lines):
        if re.match(r'(?i)\W*status\b', ln):
            more = next((x for x in lines[i + 1:] if len(x) >= 25), "")
            return (ln + (" · " + more if more else ""))[:limit]
    for ln in lines:
        if len(ln) >= 25:
            return ln[:limit]
    return lines[-1][:limit] if lines else ""


def json_unescape(s):
    try:
        return json.loads('"' + s + '"')
    except Exception:
        return s


# ── Project / session discovery ───────────────────────────────────────────────
def find_claude_project_dir(target_dir):
    claude_projects = Path.home() / ".claude" / "projects"
    if not claude_projects.exists():
        return None

    resolved_path = str(target_dir.resolve())
    encoded_cwd = re.sub(r'[^a-zA-Z0-9]', '-', resolved_path).strip('-')

    # 1. Exact match on the encoded directory name
    for p in claude_projects.iterdir():
        if p.is_dir() and p.name.strip('-') == encoded_cwd:
            return p

    # 2. Scan the "cwd" field at the top of each .jsonl log
    for p in sorted(claude_projects.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if p.is_dir():
            for jf in p.glob("*.jsonl"):
                try:
                    with open(jf, "r", encoding="utf-8") as f:
                        for _ in range(5):
                            line = f.readline()
                            if not line: break
                            entry = json.loads(line)
                            if entry.get("cwd") == resolved_path:
                                return p
                except Exception:
                    pass
    return None


def get_latest_session(project_dir):
    sessions = list(project_dir.glob("*.jsonl"))
    if not sessions:
        return None
    sessions.sort(key=lambda s: s.stat().st_mtime, reverse=True)
    return sessions[0]


def context_limit(model, cwd):
    key = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
    val = os.environ.get(key)
    if not val:
        for p in (cwd / ".claude" / "settings.local.json", cwd / ".claude" / "settings.json",
                  Path.home() / ".claude" / "settings.json"):
            try:
                with open(str(p), "r", encoding="utf-8") as f:
                    val = (json.load(f).get("env") or {}).get(key)
            except Exception:
                val = None
            if val:
                break
    try:
        return int(val)
    except (TypeError, ValueError):
        return 200_000 if re.search(r'haiku-4|-[34]-[0-5](?!\d)', model or "") else 1_000_000


# ── Log parsing (incremental: only new bytes are read each tick) ──────────────
def describe_tool(name, inp):
    def fname():
        p = inp.get("file_path") or inp.get("path") or inp.get("notebook_path") or ""
        return Path(p).name if p else "file"

    if name == "Read":
        return "read " + fname(), "read"
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        return "edit " + fname(), "edit"
    if name == "Write":
        return "write " + fname(), "edit"
    if name == "Bash":
        return "$ " + first_line(inp.get("description") or inp.get("command") or ""), "bash"
    if name in ("Grep", "Glob"):
        return name.lower() + " " + str(inp.get("pattern", "")), "search"
    if name == "Skill":
        return "skill " + str(inp.get("skill") or inp.get("name") or ""), "skill"
    if name in ("Agent", "Task"):
        return "delegate → " + str(inp.get("description") or inp.get("subagent_type") or "agent"), "delegate"
    if name == "Monitor":
        return "monitor " + str(inp.get("description") or ""), "monitor"
    if name == "TaskStop":
        return "stop task " + str(inp.get("task_id") or inp.get("shell_id") or ""), "stop"
    if name == "WebFetch":
        return "fetch " + re.sub(r'^https?://', '', str(inp.get("url", ""))).split("/")[0], "web"
    if name == "WebSearch":
        return "search " + str(inp.get("query", "")), "web"
    if name == "TodoWrite":
        return "update todos", "plan"
    if name.startswith("mcp__"):
        return "mcp " + "·".join(name.split("__")[1:3]), "mcp"
    return name, "tool"


class Meter(object):
    def __init__(self):
        self.tok = dict.fromkeys(CATS, 0)
        self.usd = dict.fromkeys(CATS, 0.0)
        self.nocache = 0.0

    def add_usage(self, model, u):
        i, o, cr, c5, c1 = rates(model)
        mult = 2.0 if u.get("speed") == "fast" else 1.0
        t_in = u.get("input_tokens", 0) or 0
        t_cr = u.get("cache_read_input_tokens", 0) or 0
        t_cw = u.get("cache_creation_input_tokens", 0) or 0
        t_out = u.get("output_tokens", 0) or 0
        w1h = min(t_cw, (u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens", 0) or 0)
        for k, v in (("in", t_in), ("cw", t_cw), ("cr", t_cr), ("out", t_out)):
            self.tok[k] += v
        cost = {"in": t_in * i, "cw": (t_cw - w1h) * c5 + w1h * c1, "cr": t_cr * cr, "out": t_out * o}
        for k in CATS:
            self.usd[k] += cost[k] * mult / 1e6
        self.nocache += ((t_in + t_cw + t_cr) * i + t_out * o) * mult / 1e6
        return sum(cost.values()) * mult / 1e6

    def add(self, other):
        for k in CATS:
            self.tok[k] += other.tok[k]
            self.usd[k] += other.usd[k]
        self.nocache += other.nocache

    @property
    def tokens(self):
        return sum(self.tok.values())

    @property
    def cost(self):
        return sum(self.usd.values())

    @property
    def input_side(self):
        return self.tok["in"] + self.tok["cw"] + self.tok["cr"]

    @property
    def hit_rate(self):
        return self.tok["cr"] / self.input_side if self.input_side else 0.0


NOTE_RE = re.compile(r'<task-notification>(.*?)</task-notification>', re.S)
REPORT_RE = re.compile(r'<agent-message from=\\?"([^"\\]+)\\?">(.*?)</agent-message>', re.S)
FINAL_STATUS = ("completed", "failed", "killed", "stopped")


def tag_value(block, tag):
    m = re.search(r'<{0}>(.*?)</{0}>'.format(tag), block, re.S)
    return json_unescape(m.group(1)).strip() if m else ""


class Log(object):
    MAX_EVENTS = 300

    def __init__(self, path):
        self.path = path
        self.offset = 0
        self.mtime = 0.0
        self.msgs = {}          # message.id -> (model, usage, ts); entries repeat per content block
        self.first = 0.0
        self.last = 0.0
        self.model = ""
        self.effort = ""
        self.ctx = 0
        self.action = ""
        self.say = ""
        self.say_ts = 0.0
        self.n_tools = 0
        self.events = []        # (ts, kind, text, tag)
        self.act_ts = []
        self.err_ts = []
        self.pending = {}       # tool_use id -> (desc, ts) still waiting for a result
        self.spawns = {}        # Agent tool_use id -> input
        self.bg = {}            # tool_use id -> background task record
        self.task_of = {}       # task id -> tool_use id
        self.notes = {}         # task id -> latest notification
        self.reports = {}       # agent id / Agent tool_use id -> one-line final report
        self._seen_notes = set()
        # context composition (characters; converted to tokens with self.k)
        self.cx = dict.fromkeys(("system", "tools_sys", "tools_mcp", "skills", "agents", "style"), 0)
        self.def_lines = {}     # deferred tool name -> listing chars
        self.mcp_instr = {}     # server -> chars
        self.mem_files = []     # (path, kind, chars)
        self.k = None           # tokens per char, calibrated on the first turn
        self.meta = None
        self.meta_mtime = 0.0
        self._meter = None

    # ---- reading ----
    def update(self):
        try:
            st = self.path.stat()
        except OSError:
            return self
        self.mtime = st.st_mtime
        if st.st_size < self.offset:
            self.__init__(self.path)
        if st.st_size > self.offset:
            with open(str(self.path), "rb") as f:
                f.seek(self.offset)
                data = f.read()
            end = data.rfind(b"\n")
            if end >= 0:
                self.offset += end + 1
                for raw in data[:end].splitlines():
                    try:
                        line = raw.decode("utf-8")
                        e = json.loads(line)
                    except Exception:
                        continue
                    try:
                        self._feed(e, line)
                    except Exception:
                        continue
                self._meter = None
                if len(self.events) > self.MAX_EVENTS:
                    self.events = self.events[-self.MAX_EVENTS:]
        return self

    def _event(self, ts, kind, text, tag):
        if ts and text:
            self.events.append((ts, kind, text, tag))

    def _feed(self, e, line):
        ts = parse_iso(e["timestamp"]) if e.get("timestamp") else 0.0
        if ts:
            if not self.first or ts < self.first:
                self.first = ts
            self.last = max(self.last, ts)
        t = e.get("type")
        msg = e.get("message") if isinstance(e.get("message"), dict) else {}

        if "<task-notification>" in line and ts:
            self._notes(line, ts)
        if "<agent-message" in line:
            for aid, body in REPORT_RE.findall(line):
                self.reports[aid] = summary_line(json_unescape(body))

        if t == "assistant":
            self._assistant(e, msg, ts)
        elif t == "user":
            self._user(e, msg, ts)
        elif t == "api-request":
            qs = e.get("querySource") or ""
            if qs.startswith("repl_main_thread") or qs == "sdk":
                eff = ((e.get("params") or {}).get("output_config") or {}).get("effort")
                self.effort = eff or self.effort
        elif t == "api-request-shape":
            self._shape(e.get("shape") or {})
        elif t == "attachment":
            self._attachment(e.get("attachment") or {})

    def _notes(self, line, ts):
        for block in NOTE_RE.findall(line):
            tid = tag_value(block, "task-id")
            if not tid:
                continue
            note = {"status": tag_value(block, "status"), "summary": tag_value(block, "summary"),
                    "event": tag_value(block, "event"), "ts": ts}
            key = (tid, note["status"], note["summary"], note["event"][:80])
            if key in self._seen_notes:
                continue
            self._seen_notes.add(key)
            prev = self.notes.get(tid)
            if prev and prev.get("final") and not note["status"]:
                continue
            note["final"] = note["status"] in FINAL_STATUS or "stream ended" in note["summary"]
            note["events"] = (prev or {}).get("events", 0) + (1 if note["event"] else 0)
            if not note["event"] and prev:
                note["event"] = prev.get("event", "")
            self.notes[tid] = note

    def _assistant(self, e, msg, ts):
        model = msg.get("model") or ""
        real = model and not model.startswith("<")
        if real:
            self.model = model
        u = msg.get("usage")
        if u and real:
            self.msgs[msg.get("id") or e.get("uuid")] = (model, u, ts)
            ctx = (u.get("input_tokens", 0) or 0) + (u.get("cache_read_input_tokens", 0) or 0) + \
                  (u.get("cache_creation_input_tokens", 0) or 0)
            if ctx:
                self.ctx = ctx
                if self.k is None:
                    chars = self.static_chars()
                    if chars > 0:
                        self.k = max(1 / 4.5, min(1 / 2.2, ctx / chars))
        if ts:
            self.act_ts.append(ts)
        for item in msg.get("content") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_use":
                name, inp = item.get("name", ""), item.get("input") or {}
                desc, tag = describe_tool(name, inp)
                self.action = desc
                self.n_tools += 1
                self.pending[item.get("id")] = (desc, ts)
                self._event(ts, "tool", desc, tag)
                if name in ("Agent", "Task"):
                    self.spawns[item.get("id")] = inp
                if inp.get("run_in_background") or name == "Monitor":
                    kind = "agent" if name in ("Agent", "Task") else ("monitor" if name == "Monitor" else "shell")
                    self.bg[item.get("id")] = {"kind": kind, "desc": first_line(inp.get("description") or desc),
                                               "cmd": first_line(inp.get("command") or ""), "start": ts, "task": None}
            elif item.get("type") == "text":
                line = summary_line(item.get("text", ""))
                if line:
                    self.action = self.say = line
                    self.say_ts = ts
                    self._event(ts, "say", line, "say")

    def _user(self, e, msg, ts):
        content = msg.get("content")
        if isinstance(content, str):
            if not e.get("isMeta") and not content.lstrip().startswith("<"):
                self._event(ts, "prompt", "» " + first_line(content), "prompt")
            return
        if not isinstance(content, list):
            return
        tur = e.get("toolUseResult") if isinstance(e.get("toolUseResult"), dict) else {}
        for item in content:
            if not (isinstance(item, dict) and item.get("type") == "tool_result"):
                continue
            tuid = item.get("tool_use_id")
            self.pending.pop(tuid, None)
            if tuid in self.spawns and not tur.get("isAsync"):
                body = item.get("content")
                if isinstance(body, list):
                    body = "\n".join(x.get("text", "") for x in body if isinstance(x, dict))
                if body:
                    self.reports[tuid] = summary_line(body)
            if tuid in self.bg:
                tid = tur.get("backgroundTaskId") or tur.get("taskId") or (tur.get("agentId") if tur.get("isAsync") else None)
                if tid:
                    self.bg[tuid]["task"] = tid
                    self.task_of[tid] = tuid
                elif item.get("is_error"):
                    del self.bg[tuid]
            if item.get("is_error"):
                body = item.get("content")
                if isinstance(body, list):
                    body = " ".join(x.get("text", "") for x in body if isinstance(x, dict))
                if ts:
                    self.err_ts.append(ts)
                self._event(ts, "fail", "✗ " + first_line(body or "error"), "fail")

    def _shape(self, shape):
        self.cx["system"] = sum(len(x.get("text", "")) for x in shape.get("system") or [] if isinstance(x, dict))
        sys_t = mcp_t = 0
        for tool in shape.get("tools") or []:
            if not isinstance(tool, dict) or tool.get("defer_loading"):
                continue
            n = len(json.dumps(tool, ensure_ascii=False))
            if str(tool.get("name", "")).startswith("mcp__"):
                mcp_t += n
            else:
                sys_t += n
        self.cx["tools_sys"], self.cx["tools_mcp"] = sys_t, mcp_t

    def _attachment(self, a):
        kind = a.get("type")
        if kind == "skill_listing":
            n = len(a.get("content") or "")
            self.cx["skills"] = n if a.get("isInitial") else self.cx["skills"] + n
        elif kind == "agent_listing_delta":
            n = sum(len(x) for x in a.get("addedLines") or [])
            self.cx["agents"] = n if a.get("isInitial") else self.cx["agents"] + n
        elif kind == "deferred_tools_delta":
            names, lines = a.get("addedNames") or [], a.get("addedLines") or []
            for i, name in enumerate(names):
                self.def_lines[name] = len(lines[i]) if i < len(lines) and len(lines) == len(names) else len(name) + 4
            for name in a.get("removedNames") or []:
                self.def_lines.pop(name, None)
        elif kind == "mcp_instructions_delta":
            names, blocks = a.get("addedNames") or [], a.get("addedBlocks") or []
            for i, name in enumerate(names):
                self.mcp_instr[name] = len(blocks[i]) if i < len(blocks) else 0
            for name in a.get("removedNames") or []:
                self.mcp_instr.pop(name, None)
        elif kind == "instructions":
            self.mem_files = [(f.get("path", ""), f.get("type", ""), len(f.get("content") or ""))
                              for f in a.get("files") or [] if isinstance(f, dict)]
        elif kind == "output_style_instructions":
            self.cx["style"] = len(((a.get("style") or {}).get("prompt")) or "")

    # ---- derived ----
    def static_chars(self):
        return (sum(self.cx.values()) + sum(self.def_lines.values()) + sum(self.mcp_instr.values()) +
                sum(m[2] for m in self.mem_files))

    def meter(self):
        if self._meter is None:
            m = Meter()
            for model, u, _ in self.msgs.values():
                m.add_usage(model, u)
            self._meter = m
        return self._meter

    def in_flight(self, now):
        """Latest tool call still waiting for its result (ignores stale ones)."""
        live = [(ts, d) for d, ts in self.pending.values() if ts and now - ts < 3600]
        return max(live) if live else None

    def load_meta(self):
        mp = self.path.with_suffix(".meta.json")
        try:
            mt = mp.stat().st_mtime
            if self.meta is None or mt != self.meta_mtime:
                with open(str(mp), "r", encoding="utf-8") as f:
                    self.meta = json.load(f)
                self.meta_mtime = mt
        except Exception:
            if self.meta is None:
                self.meta = {}
        return self.meta


# ── Background tasks ──────────────────────────────────────────────────────────
_OUTPUT_PATHS = {}


def task_output_tail(proj_name, task_id):
    """Last non-empty line of a running background task's output file."""
    path = _OUTPUT_PATHS.get(task_id)
    if path is None:
        hits = []
        for root in ("/private/tmp", "/tmp"):
            hits = list(Path(root).glob("claude-{}/{}/*/tasks/{}.output".format(os.getuid(), proj_name, task_id)))
            if hits:
                break
        path = _OUTPUT_PATHS[task_id] = hits[0] if hits else ""
    if not path:
        return ""
    try:
        with open(str(path), "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 4096))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return ""
    for ln in reversed(re.split(r'[\r\n]+', strip_ansi(text))):
        if ln.strip():
            return ln.strip()
    return ""


class Task(object):
    def __init__(self, rec, note, owner, owner_color, now, alive, proj_name):
        self.kind = rec["kind"]
        self.desc = rec["desc"] or rec["cmd"] or "background task"
        self.owner, self.owner_color = owner, owner_color
        self.start = rec["start"]
        self.id = rec["task"] or ""
        note = note or {}
        self.status = note.get("status", "")
        self.summary = note.get("summary", "")
        self.event = first_line(note.get("event", ""))
        self.events = note.get("events", 0)
        m = re.search(r'exit code (-?\d+)', self.summary)
        self.exit = int(m.group(1)) if m else None
        if note.get("final"):
            self.state = "fail" if (self.status == "failed" or (self.exit or 0) != 0) else \
                ("stop" if self.status in ("killed", "stopped") else "done")
            self.end = note.get("ts") or now
        else:
            self.state = "run" if alive else "lost"
            self.end = now if alive else (note.get("ts") or self.start)
        self.tail = ""
        if self.state == "run":
            self.tail = self.event if self.kind == "monitor" else task_output_tail(proj_name, self.id)

    @property
    def duration(self):
        return max(0.0, self.end - self.start) if self.start else 0.0


# ── Session model ─────────────────────────────────────────────────────────────
class Agent(object):
    def __init__(self, log, spawn, note, now, index, report=""):
        meta = log.load_meta()
        self.report = report
        self.log = log
        self.id = log.path.stem.replace("agent-", "")
        self.type = meta.get("agentType") or spawn.get("subagent_type") or "agent"
        self.desc = meta.get("description") or spawn.get("description") or self.type
        self.effort = meta.get("effort") or spawn.get("effort") or ""
        self.model = log.model or meta.get("pickedEffortModel") or ""
        self.background = bool(spawn.get("run_in_background"))
        self.meter = log.meter()
        self.color = LANE_COLORS[index % len(LANE_COLORS)]
        self.idle = now - log.mtime
        self.flight = log.in_flight(now)
        self.tasks = []
        finished = meta.get("finished")
        note = note or {}
        if note.get("final"):
            running = False
        elif finished is not None:
            running = not finished and (self.idle < 1800 or self.flight is not None)
        else:
            running = self.idle < 20 or self.flight is not None or (self.background and self.idle < 1800)
        if note.get("final") and note.get("status") in ("failed", "killed", "stopped"):
            self.state = "fail" if note["status"] == "failed" else "stop"
        elif running and not self.flight and self.idle > STALL_SECS:
            self.state = "stall"
        elif running:
            self.state = "run"
        else:
            self.state = "done"
        self.end = now if self.state in ("run", "stall") else (log.last or log.mtime)

    @property
    def label(self):
        return self.desc

    @property
    def live(self):
        return self.state in ("run", "stall", "wait")


class Monitor(object):
    def __init__(self):
        self.logs = {}

    def log(self, path):
        lg = self.logs.get(path)
        if lg is None:
            lg = self.logs[path] = Log(path)
        return lg.update()

    def collect(self, session_file, target):
        now = time.time()
        proj_name = session_file.parent.name
        main = self.log(session_file)
        agents = []
        sub_dir = session_file.parent / session_file.stem / "subagents"
        if sub_dir.exists():
            files = sorted(sub_dir.glob("agent-*.jsonl"), key=lambda p: p.stat().st_mtime)
            for idx, jf in enumerate(files):
                lg = self.log(jf)
                agent_id = jf.stem.replace("agent-", "")
                tuid = lg.load_meta().get("toolUseId")
                report = main.reports.get(agent_id) or main.reports.get(tuid) or ""
                agents.append(Agent(lg, main.spawns.get(tuid, {}), main.notes.get(agent_id), now, idx, report))

        main_flight = main.in_flight(now)
        main_recent = (now - main.mtime) < 15 or main_flight is not None
        alive = (now - main.mtime) < 3600

        # background shell / monitor tasks (main + every subagent)
        tasks = []
        owners = [("main", model_color(main.model), main, None)] + [(a.label, a.color, a.log, a) for a in agents]
        for owner, color, lg, agent in owners:
            for tuid, rec in lg.bg.items():
                if rec["kind"] == "agent":
                    continue
                note = lg.notes.get(rec["task"]) if rec["task"] else None
                owner_alive = alive and (agent is None or agent.live or (now - lg.mtime) < 3600)
                task = Task(rec, note, owner, color, now, owner_alive, proj_name)
                tasks.append(task)
                if agent is not None:
                    agent.tasks.append(task)
        for a in agents:
            if a.state == "done" and any(t.state == "run" for t in a.tasks):
                a.state = "wait"
        order = {"run": 0, "stall": 1, "wait": 2, "fail": 3, "stop": 4, "done": 5}
        agents.sort(key=lambda a: (order.get(a.state, 9), -a.log.mtime))
        tasks.sort(key=lambda t: (t.state != "run", -(t.end or 0)))

        total, sub = Meter(), Meter()
        total.add(main.meter())
        for a in agents:
            sub.add(a.meter)
        total.add(sub)

        # burn rate & 30-minute cost sparkline
        buckets = [0.0] * 30
        burn = 0.0
        for lg in [main] + [a.log for a in agents]:
            for model, u, ts in lg.msgs.values():
                age = now - ts if ts else 1e9
                if age < 1800:
                    cost = Meter().add_usage(model, u)
                    buckets[29 - int(age // 60)] += cost
                    if age < 600:
                        burn += cost
        running = sum(1 for a in agents if a.live)
        active = main_recent or running > 0 or any(t.state == "run" for t in tasks)
        t0 = min([x for x in [main.first] + [a.log.first for a in agents] if x] or [now])
        t1 = now if active else max([main.last] + [a.log.last for a in agents] + [t0])
        limit = context_limit(main.model, target)
        S = {
            "file": session_file, "target": target, "now": now, "main": main, "agents": agents, "tasks": tasks,
            "total": total, "sub": sub, "running": running, "active": active, "main_flight": main_flight,
            "state": "working" if main_recent else ("waiting on agents" if running else "idle"),
            "t0": t0, "t1": t1, "burn": burn * 6, "spark": buckets, "limit": limit,
        }
        S["context"] = context_breakdown(main, limit)
        S["alerts"] = build_alerts(S)
        return S


def context_breakdown(main, limit):
    k = main.k or 0.3
    mcp_def = sum(v for n, v in main.def_lines.items() if n.startswith("mcp__"))
    sys_def = sum(v for n, v in main.def_lines.items() if not n.startswith("mcp__"))
    cats = [
        ("MCP tools", (main.cx["tools_mcp"] + mcp_def) * k, C_BLUE),
        ("System prompt", (main.cx["system"] + main.cx["style"]) * k, C_ORANGE),
        ("Skills", main.cx["skills"] * k, C_GREEN),
        ("System tools", (main.cx["tools_sys"] + sys_def) * k, C_GOLD),
        ("Agents", main.cx["agents"] * k, C_PINK),
        ("Memory files", sum(m[2] for m in main.mem_files) * k, C_CYAN),
        ("MCP instructions", sum(main.mcp_instr.values()) * k, C_LIGHT),
    ]
    static = sum(v for _, v, _ in cats)
    if static > main.ctx > 0:          # estimates never exceed the exact total
        cats = [(n, v * main.ctx / static, col) for n, v, col in cats]
        static = main.ctx
    cats.insert(4, ("Messages", max(0, main.ctx - static), C_PURPLE))
    buffer = AUTOCOMPACT_BUFFER if limit > 4 * AUTOCOMPACT_BUFFER else 0
    return {
        "limit": limit, "used": main.ctx, "cats": [x for x in cats if x[1] >= 1 or x[0] == "Messages"],
        "buffer": buffer, "free": max(0, limit - main.ctx - buffer),
        "mcp_deferred": sum(1 for n in main.def_lines if n.startswith("mcp__")),
        "sys_deferred": sum(1 for n in main.def_lines if not n.startswith("mcp__")),
        "mem_files": [(Path(p).name, kind, n * k) for p, kind, n in main.mem_files],
        "estimated": main.k is not None,
    }


def build_alerts(S):
    alerts = []
    for a in S["agents"]:
        if a.state == "stall":
            alerts.append((C_GOLD, "⚠ {} idle {}".format(fit(a.label, 24), fmt_duration(a.idle))))
        elif a.state == "fail":
            alerts.append((C_RED, "✗ agent {} failed".format(fit(a.label, 24))))
    recent_fail = [t for t in S["tasks"] if t.state == "fail" and S["now"] - t.end < 1800]
    for t in recent_fail[:2]:
        alerts.append((C_RED, "✗ bg task {} {}".format(fit(t.desc, 28), "exit {}".format(t.exit) if t.exit else "failed")))
    cx = S["context"]
    if cx["limit"]:
        pct = cx["used"] / max(1, cx["limit"] - cx["buffer"])
        if pct >= 0.8:
            alerts.append((C_RED if pct >= 0.9 else C_GOLD, "⚠ context {:.0f}% of compaction window".format(pct * 100)))
    return alerts


# ── Drawing primitives ────────────────────────────────────────────────────────
def box(content, w, color, align="<", title=None, right=None):
    inner = w - 4
    t = (" " + title + " ") if title else ""
    r = (" " + right + " ") if right else ""
    fill = max(0, w - 3 - vlen(t) - vlen(r) - (1 if r else 0))
    top = color + "╭─" + RESET + t + color + "─" * fill + RESET + r + (color + "─" if r else "") + color + "╮" + RESET
    out = [top]
    for line in content:
        out.append(color + "│" + RESET + " " + pad(line, inner, align) + " " + color + "│" + RESET)
    out.append(color + "╰" + "─" * (w - 2) + "╯" + RESET)
    return out


def title(text, color=C_WHITE):
    return c(BOLD + color, text)


def center_block(lines, w):
    return [pad(line, w, "^") for line in lines]


def hconcat(blocks, widths, gap=2):
    rows = max(len(b) for b in blocks)
    out = []
    for i in range(rows):
        parts = [pad(b[i] if i < len(b) else "", wd) for b, wd in zip(blocks, widths)]
        out.append((" " * gap).join(parts))
    return out


def card_centers(n, w, gap=2):
    cw = (w - gap * (n - 1)) // n
    return cw, [k * (cw + gap) + cw // 2 for k in range(n)]


def branch_line(centers, w, tick, active, down=True):
    """Fan-out (down=True) or fan-in line connecting box centers to the middle."""
    cells = [" "] * w
    mid = w // 2
    lo, hi = min(centers + [mid]), max(centers + [mid])
    for x in range(lo, hi + 1):
        cells[x] = "─"
    for x in centers:
        cells[x] = "▼" if down else "┘" if x == hi else "└" if x == lo else "┴"
    if mid in centers:
        cells[mid] = "▼" if down else "┼"
    else:
        cells[mid] = "┴" if down else "┬"
    colors = [C_DARK] * w
    if active and hi > lo:
        p = lo + (tick % (hi - lo + 1))
        if cells[p] == "─":
            cells[p], colors[p] = "•", C_GOLD
    out, cur = [], None
    for ch, col in zip(cells, colors):
        if col != cur:
            out.append(col)
            cur = col
        out.append(ch)
    return "".join(out) + RESET


# ── Panels ────────────────────────────────────────────────────────────────────
def build_header(S, w, tick):
    main = S["main"]
    live = pill("● LIVE", 114, 8) if S["active"] else pill("IDLE", 240, 6, 255)
    head = (live + "  " + c(BOLD + C_WHITE, "✳ CLAUDE CODE MONITOR") + c(C_DARK, "  ·  ") +
            c(BOLD + C_ORANGE, fit((S["target"].name or "/").upper(), max(8, w - 70))) + c(C_DARK, "  ·  ") +
            c(BOLD + C_GOLD, fmt_cost(S["total"].cost)) + c(BOLD + C_WHITE, " OF TOKENS"))
    if vlen(head) > w:
        head = live + " " + c(BOLD + C_WHITE, "✳ MONITOR ") + c(BOLD + C_ORANGE, fit(S["target"].name.upper(), 14)) + \
            " " + c(BOLD + C_GOLD, fmt_cost(S["total"].cost))
    sub = fit("{}  ·  session {}  ·  {}".format(str(S["target"]).replace(str(Path.home()), "~"),
                                                S["file"].stem[:8], hhmmss(S["now"])), w)
    i, o, cr, c5, _ = rates(main.model)
    legend = "  ".join([
        c(model_color(main.model), "■") + " " + pretty_model(main.model) + c(C_DARK, " · ") + "main",
        c(C_ORANGE, "■") + " input " + fmt_rate(i),
        c(C_PINK, "■") + " cache write " + fmt_rate(c5),
        c(C_BLUE, "■") + " cache read " + fmt_rate(cr),
        c(C_GOLD, "■") + " output " + fmt_rate(o),
        c(C_GRAY, "per MTok"),
    ])
    if vlen(legend) > w:
        legend = "  ".join([c(C_ORANGE, "■") + " in " + fmt_rate(i), c(C_PINK, "■") + " cw " + fmt_rate(c5),
                            c(C_BLUE, "■") + " cr " + fmt_rate(cr), c(C_GOLD, "■") + " out " + fmt_rate(o)])
    out = [pad(head, w, "^"), pad(c(C_GRAY, sub), w, "^"), c(C_FRAME, "═" * w), pad(legend, w, "^")]
    if S["alerts"]:
        parts, used = [], 0
        for col, text in S["alerts"]:
            if used + vlen(text) + 3 > w:
                break
            parts.append(c(col, text))
            used += vlen(text) + 3
        out.append(pad(c(C_DARK, " · ").join(parts), w, "^"))
    return out


def build_flow(S, R, tick):
    main, total = S["main"], S["total"]
    active = S["active"]
    spin = SPIN[tick % len(SPIN)]
    out = []
    mm = main.meter()

    # 1. main session box
    mw = min(R, max(46, R * 2 // 3))
    inner = mw - 4
    state = c(C_GREEN, spin + " " + S["state"]) if S["state"] != "idle" else c(C_GRAY, "○ idle")
    mcol = model_color(main.model)
    l1 = c(BOLD + mcol, pretty_model(main.model)) + c(C_DARK, " · ") + c(C_WHITE, "main session ") + state
    if vlen(l1) > inner:
        l1 = c(BOLD + mcol, pretty_model(main.model)) + c(C_DARK, " · ") + state
    flight = S["main_flight"]
    if flight and S["state"] == "working":
        tail = " ({})".format(fmt_duration(S["now"] - flight[0]))
        l2 = c(C_GOLD, "» " + fit(flight[1], inner - 2 - len(tail))) + c(C_GRAY, tail)
    else:
        l2 = c(C_GOLD, "» " + fit(main.action or "waiting for prompt", inner - 2))
    eff = (c(C_GRAY, "effort ") + c(C_PINK, main.effort) + c(C_DARK, " · ")) if main.effort else ""
    l3 = (eff + "context " + c(BOLD + C_WHITE, "{:,}".format(main.ctx)) + c(C_GRAY, " / " + fmt_tok(S["limit"])) +
          c(C_DARK, " · ") + "cache " + c(BOLD + C_BLUE, "{:.0f}%".format(mm.hit_rate * 100)) +
          c(C_DARK, " · ") + c(C_GRAY, fmt_duration(S["t1"] - S["t0"])))
    if vlen(l3) > inner:
        l3 = ((c(C_PINK, main.effort) + c(C_DARK, " · ") if main.effort else "") + "ctx " +
              c(BOLD + C_WHITE, fmt_tok(main.ctx)) + c(C_GRAY, "/" + fmt_tok(S["limit"])) + c(C_DARK, " · ") +
              "cache " + c(BOLD + C_BLUE, "{:.0f}%".format(mm.hit_rate * 100)))
    out += center_block(box([pad(l1, inner, "^"), pad(l2, inner, "^"), pad(l3, inner, "^")], mw,
                            mcol if S["state"] != "idle" else C_DARK), R)

    # 2. team summary line
    n_bg = sum(1 for t in S["tasks"] if t.state == "run")
    team = (c(C_GRAY, "delegate · {} agents · ".format(len(S["agents"]))) +
            c(C_GREEN if S["running"] else C_GRAY, "{} live".format(S["running"])) + c(C_GRAY, " · ") +
            c(C_CYAN if n_bg else C_GRAY, "{} bg tasks".format(n_bg)))
    hits = c(BOLD + C_BLUE, "{:.0f}% cache hits".format(total.hit_rate * 100))
    out.append(pad(team + c(C_DARK, "  ·  ") + hits if vlen(team) + vlen(hits) + 5 <= R else team, R, "^"))

    # 3. meters
    mcw, mcenters = card_centers(4, R)
    out.append(branch_line(mcenters, R, tick, active))
    tot_cost = total.cost or 1.0
    mi = mcw - 4
    status = c(C_GOLD, fit(PIE[tick % 4] + " counting", mi)) if active else c(C_GRAY, fit("✓ final", mi))
    meters = []
    for key, name, sub, col in (("in", "input", "uncached", C_ORANGE), ("cw", "cache write", "written", C_PINK),
                                ("cr", "cache read", "hits", C_BLUE), ("out", "output", "generated", C_GOLD)):
        sub = "{} · {}".format(sub, fmt_tok(total.tok[key]))
        meters.append(box([
            pad(c(BOLD + C_WHITE, fit(name, mi)), mi, "^"),
            pad(c(C_GRAY, sub if len(sub) <= mi else fmt_tok(total.tok[key]) + " tok"), mi, "^"),
            bar(total.usd[key] / tot_cost, mi, col),
            pad(c(BOLD + col, fmt_cost(total.usd[key])), mi, "^"),
            pad(status, mi, "^"),
        ], mcw, col))
    out += hconcat(meters, [mcw] * 4)
    out.append(branch_line(mcenters, R, tick, False, down=False))

    # 4. the bill
    bstate = c(C_GREEN, spin + " running") if active else c(C_GRAY, "settled")
    b1 = c(BOLD + C_GOLD, "the bill") + c(C_DARK, " · ") + bstate
    b2 = c(BOLD + C_GOLD, fmt_cost(total.cost)) + c(C_GRAY, " so far · ") + c(BOLD + C_WHITE, fmt_tok(total.tokens)) + c(C_GRAY, " tokens")
    b3 = c(C_GRAY, fit("main {} · agents {} · {}/h".format(fmt_cost(mm.cost), fmt_cost(S["sub"].cost),
                                                         fmt_cost(S["burn"])), mw - 4))
    out += center_block(box([pad(b1, mw - 4, "^"), pad(b2, mw - 4, "^"), pad(b3, mw - 4, "^")], mw, C_GOLD), R)
    return out


def build_bill(S, w):
    inner = w - 4
    main, total = S["main"], S["total"]
    i, o, _, _, _ = rates(main.model)
    saved = max(0.0, 1 - total.cost / total.nocache) * 100 if total.nocache else 0
    burn_col = C_RED if S["burn"] > 20 else (C_GOLD if S["burn"] > 5 else C_GREEN)
    lines = [
        c(C_GRAY, fit("{} · {} in · {} out /MTok".format(pretty_model(main.model).lower(), fmt_rate(i), fmt_rate(o)), inner)),
        spread(c(BOLD + C_WHITE, "total"), c(BOLD + C_GOLD, fmt_cost(total.cost)), inner),
        spread(c(C_GRAY, "main"), c(C_GOLD, fmt_cost(main.meter().cost)), inner),
        spread(c(C_GRAY, "agents ({})".format(len(S["agents"]))), c(C_GOLD, fmt_cost(S["sub"].cost)), inner),
        "",
        spread(c(C_GRAY, "cache hits"), c(BOLD + C_BLUE, "{:.0f}%".format(total.hit_rate * 100)), inner),
        spread(c(C_GRAY, "no cache"), c(C_RED + STRIKE, fmt_cost(total.nocache)), inner),
        spread(c(C_GRAY, "saved"), c(BOLD + C_GREEN, "{:.0f}%".format(saved)), inner),
        "",
        spread(c(C_GRAY, "burn (10m)"), c(BOLD + burn_col, fmt_cost(S["burn"]) + "/h"), inner),
        sparkline(S["spark"][-inner:], C_GOLD),
        spread(c(C_DARK, "-30m"), c(C_DARK, "now"), min(inner, 30)),
    ]
    return box(lines, w, C_GOLD, title=title("THE BILL", C_GOLD))


def build_context(S, w):
    inner = w - 4
    cx = S["context"]
    limit = cx["limit"] or 1
    pct = cx["used"] / limit * 100
    pct_col = C_RED if pct > 75 else (C_GOLD if pct > 50 else C_WHITE)
    lines = [spread(c(BOLD + pct_col, "{:.0f}% used".format(pct)),
                    c(C_GRAY, "{} / {}".format(fmt_tok(cx["used"]), fmt_tok(limit))), inner)]
    # segmented bar
    segs, acc = [], 0
    for name, tok, col in cx["cats"] + [("Autocompact buffer", cx["buffer"], C_DARK)]:
        n = int(round(tok / limit * inner))
        if tok > 0 and n == 0 and acc < inner:
            n = 1
        n = min(n, inner - acc)
        if n > 0:
            segs.append(c(col, "━" * n))
            acc += n
    segs.append(c(C_TRACK, "━" * (inner - acc)))
    lines.append("".join(segs))
    nw = inner - 2 - 7 - 7

    def row(sq, name, tok, pct_txt, name_col=C_LIGHT):
        return sq + " " + c(name_col, pad(fit(name, nw), nw)) + pad(fmt_tok(tok) if isinstance(tok, (int, float)) else tok, 7, ">") + \
            c(C_GRAY, pad(pct_txt, 7, ">"))

    for name, tok, col in cx["cats"]:
        lines.append(row(c(col, "■"), name, tok, "{:.1f}%".format(tok / limit * 100)))
    lines.append(row(c(C_DARK, "■"), "Autocompact buffer", cx["buffer"], "{:.1f}%".format(cx["buffer"] / limit * 100)))
    lines.append(row(c(C_TRACK, "■"), "Free space", cx["free"], "{:.1f}%".format(cx["free"] / limit * 100), C_GRAY))
    if cx["mcp_deferred"] or cx["sys_deferred"]:
        lines.append("")
        for label, n in (("MCP tools (deferred)", cx["mcp_deferred"]), ("System tools (deferred)", cx["sys_deferred"])):
            if n:
                lines.append(spread(c(C_DARK, "□ ") + c(C_GRAY, fit(label, inner - 12)), c(C_GRAY, "{} tools".format(n)), inner))
    if cx["mem_files"]:
        lines.append(spread(c(C_GRAY, "▾ Memory files"), c(C_GRAY, str(len(cx["mem_files"]))), inner))
        for name, kind, tok in cx["mem_files"]:
            lines.append(c(C_DARK, "  └ ") + pad(c(C_LIGHT, fit(name, inner - 14)), inner - 11) + pad(fmt_tok(tok), 7, ">"))
    note = c(C_DARK, "breakdown ≈ est.") if cx["estimated"] else None
    return box(lines, w, C_FRAME, title=title("CONTEXT"), right=note)


def build_share(S, w, n):
    inner = w - 4
    total = S["total"].tokens or 1
    rows = [("main", S["main"].meter().tokens, model_color(S["main"].model))]
    ranked = sorted(S["agents"], key=lambda a: -a.meter.tokens)
    top = ranked[:max(0, n - 2)] if len(ranked) > n - 1 else ranked
    rows += [(a.label, a.meter.tokens, a.color) for a in top]
    if len(ranked) > len(top):
        rows.append(("+{} others".format(len(ranked) - len(top)), sum(a.meter.tokens for a in ranked[len(top):]), C_GRAY))
    lw = max(8, min(22, inner // 3))
    bw = max(4, inner - lw - 1 - 12)
    content = []
    for name, tok, color in rows[:n]:
        frac = tok / total
        content.append(c(color, pad(fit(name, lw), lw)) + " " + bar(frac, bw, color) +
                       c(C_GRAY, pad(fmt_tok(tok), 7, ">") + pad("{:.0f}%".format(frac * 100), 5, ">")))
    content += [""] * (n - len(content))
    return box(content, w, C_FRAME, title=title("WHO SEES WHAT") + c(C_GRAY, " · tokens"))


STATE_PILL = {"run": ("RUN", 114), "stall": ("IDLE?", 221), "wait": ("WAIT", 75),
              "done": ("DONE", 239), "fail": ("FAIL", 203), "stop": ("STOP", 209), "lost": ("LOST", 239)}


def state_pill(state, w=7):
    label, color = STATE_PILL.get(state, ("?", 239))
    return pill(label, color, w, 255 if color == 239 else 16)


def build_agents(S, w, max_rows, two_line, tick):
    inner = w - 4
    agents = S["agents"]
    spin = SPIN[tick % len(SPIN)]
    counts = {}
    for a in agents:
        counts[a.state] = counts.get(a.state, 0) + 1
    right = "  ".join(c(col, "{} {}".format(counts[k], name)) for k, name, col in
                      (("run", "running", C_GREEN), ("stall", "idle?", C_GOLD), ("wait", "waiting", C_BLUE),
                       ("fail", "failed", C_RED), ("done", "done", C_GRAY)) if counts.get(k))
    if not agents:
        return box([c(C_DARK, "no subagents spawned yet — delegate with the Agent tool and they show up here")],
                   w, C_FRAME, title=title("AGENTS"))
    compact = inner < 84
    name_w = max(12, min(30, inner // 4))
    stats_w = 14 if compact else 31
    now_w = max(8, inner - 8 - name_w - 1 - stats_w - 1)
    head = c(C_DARK, pad("STATE", 8) + pad("AGENT", name_w + 1) + pad("NOW", now_w + 1) + pad("STEPS", 6, ">") +
             ("" if compact else pad("TIME", 9, ">") + pad("TOKENS", 8, ">")) + pad("COST", 8, ">"))
    lines = [head]
    shown = 0
    for a in agents:
        rows_needed = 2 if (two_line and a.state != "done") else 1
        if len(lines) - 1 + rows_needed > max_rows:
            break
        shown += 1
        # NOW column: live tool > narration > final report
        if a.state in ("run", "stall") and a.flight:
            tail = " " + fmt_duration(S["now"] - a.flight[0])
            now_txt = c(C_GREEN, spin + " " + fit(a.flight[1], now_w - 2 - len(tail))) + c(C_GRAY, tail)
        elif a.state == "stall":
            now_txt = c(C_GOLD, fit("no activity {} · last: {}".format(fmt_duration(a.idle), a.log.action), now_w))
        elif a.state == "run":
            now_txt = c(C_GREEN, fit("» " + (a.log.action or "starting"), now_w))
        elif a.state == "wait":
            n = sum(1 for t in a.tasks if t.state == "run")
            now_txt = c(C_BLUE, fit("◷ waiting on {} bg task{}".format(n, "s" if n > 1 else ""), now_w))
        else:
            now_txt = c(C_LIGHT if a.state == "done" else C_RED,
                        fit(a.report or a.log.say or a.log.action or "—", now_w))
        errs = len(a.log.err_ts)
        steps = (c(C_RED, "✗{} ".format(errs)) if errs else "") + c(C_LIGHT, str(a.log.n_tools))
        name = c(BOLD + a.color if a.live else a.color, fit(a.label, name_w))
        stats = pad(steps, 6, ">") + ("" if compact else
                                      c(C_GRAY, pad(fmt_duration(a.end - a.log.first) if a.log.first else "—", 9, ">")) +
                                      c(C_LIGHT, pad(fmt_tok(a.meter.tokens), 8, ">"))) + c(C_GOLD, pad(fmt_cost(a.meter.cost), 8, ">"))
        lines.append(state_pill(a.state) + " " + pad(name, name_w) + " " + pad(now_txt, now_w) + " " + stats)
        if rows_needed == 2:
            bits = [a.type.replace("general-purpose", "general"), pretty_model(a.model)] + \
                ([a.effort] if a.effort else []) + (["bg"] if a.background else [])
            if a.tasks:
                nf = sum(1 for t in a.tasks if t.state == "fail")
                bits.append("{} bg task{}{}".format(len(a.tasks), "s" if len(a.tasks) > 1 else "",
                                                     ", {} failed".format(nf) if nf else ""))
            meta = " · ".join(bits)
            say = a.log.say if a.log.say_ts and a.log.say_ts >= (a.flight[0] if a.flight else 0) - 600 else ""
            left = c(C_DARK, "        └ ") + c(C_GRAY, fit(meta, max(10, min(vlen(meta), inner * 2 // 5))))
            room = inner - vlen(left) - 3
            if say and room > 8:
                left += c(C_DARK, " │ ") + c(ITALIC + C_LIGHT, fit("“" + say + "”", room))
            lines.append(left)
    if shown < len(agents):
        rest = agents[shown:]
        lines.append(c(C_DARK, fit("  +{} more · {} · {}".format(len(rest), fmt_tok(sum(a.meter.tokens for a in rest)),
                                                                   fmt_cost(sum(a.meter.cost for a in rest))), inner)))
    return box(lines, w, C_FRAME, title=title("AGENTS") + c(C_GRAY, " · {}".format(len(agents))), right=right)


def build_tasks(S, w, max_rows, tick):
    inner = w - 4
    tasks = S["tasks"]
    run = sum(1 for t in tasks if t.state == "run")
    fail = sum(1 for t in tasks if t.state == "fail")
    right = "  ".join(x for x in [c(C_GREEN, "{} running".format(run)) if run else "",
                                  c(C_GRAY, "{} finished".format(len(tasks) - run)),
                                  c(C_RED, "{} failed".format(fail)) if fail else ""] if x)
    if not tasks:
        return box([c(C_DARK, "no background tasks (run_in_background / Monitor)")], w, C_FRAME,
                   title=title("BACKGROUND TASKS"))
    owner_w = max(8, min(20, inner // 6))
    res_w = 12
    desc_w = max(10, inner - 2 - 1 - owner_w - 1 - 9 - 1 - res_w)
    spin = SPIN[tick % len(SPIN)]
    icons = {"run": (C_GREEN, spin), "done": (C_GREEN, "✓"), "fail": (C_RED, "✗"), "stop": (C_GOLD, "■"),
             "lost": (C_DARK, "?")}
    lines = []
    shown = 0
    for t in tasks:
        need = 2 if (t.state == "run" and t.tail) else 1
        if len(lines) + need > max_rows:
            break
        shown += 1
        col, icon = icons.get(t.state, (C_GRAY, "·"))
        kind = "⌁ " if t.kind == "monitor" else ""
        if t.state == "run":
            res = c(C_GREEN, "running") if t.kind != "monitor" else c(C_CYAN, "{} events".format(t.events))
        elif t.state == "fail":
            res = c(C_RED, "exit {}".format(t.exit) if t.exit else t.status or "failed")
        elif t.state == "stop":
            res = c(C_GOLD, t.status or "stopped")
        elif t.state == "lost":
            res = c(C_DARK, "no result")
        else:
            res = c(C_GRAY, "exit 0" if t.exit == 0 else (t.status or "done"))
        desc_col = C_WHITE if t.state == "run" else (C_RED if t.state == "fail" else C_LIGHT)
        lines.append(c(col, icon) + " " + c(desc_col, pad(fit(kind + t.desc, desc_w), desc_w)) + " " +
                     c(t.owner_color, pad(fit(t.owner, owner_w), owner_w)) + " " +
                     c(C_GRAY, pad(fmt_duration(t.duration), 9, ">")) + " " + pad(res, res_w, ">"))
        if need == 2:
            lines.append(c(C_DARK, "  └ ") + c(C_GRAY, fit(t.tail, inner - 4)))
    if shown < len(tasks):
        lines.append(c(C_DARK, "  +{} older".format(len(tasks) - shown)))
    return box(lines, w, C_FRAME, title=title("BACKGROUND TASKS"), right=right)


def build_timeline(S, w, max_lanes):
    t0, t1 = S["t0"], S["t1"]
    span = max(1.0, t1 - t0)
    label_w = max(11, min(18, w // 8))
    bw = max(10, w - 4 - label_w)

    def col(ts):
        return int((ts - t0) / span * (bw - 1))

    lanes = [("main", S["main"], model_color(S["main"].model))] + \
            [(a.label, a.log, a.color) for a in S["agents"][:max_lanes - 1]]
    content = []
    for name, lg, color in lanes:
        cells = [(" ", "")] * bw
        if lg.first:
            for x in range(max(0, col(lg.first)), min(bw, col(lg.last or lg.first) + 1)):
                cells[x] = ("·", C_TRACK)
        for ts in lg.act_ts:
            if ts >= t0:
                cells[min(bw - 1, col(ts))] = ("━", color)
        for ts in lg.err_ts:
            if ts >= t0:
                cells[min(bw - 1, col(ts))] = ("✗", C_RED)
        line, cur = [c(color, pad(fit(name, label_w - 1), label_w))], None
        for ch, cl in cells:
            if cl != cur:
                line.append(RESET + cl)
                cur = cl
            line.append(ch)
        content.append("".join(line) + RESET)
    left, mid, right = hhmmss(t0), hhmmss(t0 + span / 2), "now" if S["active"] else hhmmss(t1)
    axis = " " * label_w + left + " " * max(1, bw // 2 - len(left) - len(mid) // 2) + mid
    content.append(c(C_GRAY, spread(axis, right, label_w + bw)))
    return box(content, w, C_FRAME, title=title("SESSION TIMELINE") + c(C_GRAY, " · " + fmt_duration(span)))


def build_log(S, w, n):
    inner = w - 4
    mcol = model_color(S["main"].model)
    events = [(ts, "you" if kind == "prompt" else "main", C_GREEN if kind == "prompt" else mcol, text, tag)
              for ts, kind, text, tag in S["main"].events[-n:]]
    for a in S["agents"][:30]:
        events += [(ts, a.label, a.color, text, tag) for ts, kind, text, tag in a.log.events[-n:] if kind != "prompt"]
    events = sorted(events, key=lambda e: e[0])[-n:]
    who_w = max(9, min(16, inner // 7))
    content = []
    for ts, who, color, text, tag in events:
        tg = "[{}]".format(tag)
        left = c(C_DARK, hhmmss(ts)) + "  " + c(color, pad(fit(who, who_w), who_w)) + " "
        room = inner - vlen(left) - len(tg) - 1
        body = c(C_RED, fit(text, room)) if tag == "fail" else c(C_LIGHT if tag != "say" else ITALIC + C_WHITE, fit(text, room))
        content.append(spread(left + body, c(C_RED if tag == "fail" else C_DARK, tg), inner))
    content += [""] * (n - len(content))
    return box(content, w, C_FRAME, title=title("TAIL -F SESSION.LOG"))


def build_status(S, w, tick, watch):
    cursor = c(C_GREEN, "█") if tick % 2 == 0 or not watch else " "

    def seg(k, v, col):
        return c(C_GRAY, k + " ") + c(col, "[" + v + "]")

    parts = [c(C_GREEN, "❯ ") + cursor,
             seg("model", pretty_model(S["main"].model), model_color(S["main"].model)),
             seg("effort", S["main"].effort or "—", C_PINK),
             seg("ctx", "{} {:.0f}%".format(fmt_tok(S["main"].ctx), S["main"].ctx / max(1, S["limit"]) * 100), C_WHITE),
             seg("bill", fmt_cost(S["total"].cost), C_GOLD),
             seg("burn", fmt_cost(S["burn"]) + "/h", C_GOLD),
             seg("agents", "{}/{}".format(S["running"], len(S["agents"])), C_GREEN),
             seg("bg", str(sum(1 for t in S["tasks"] if t.state == "run")), C_CYAN)]
    while len(parts) > 3 and vlen("  ".join(parts)) > w - (14 if watch else 0):
        parts.pop(-1)
    line = "  ".join(parts)
    return spread(line, c(C_DARK, "ctrl+c quit"), w) if watch and vlen(line) + 14 <= w else line


# ── Layout ────────────────────────────────────────────────────────────────────
def build_top(S, W, tick):
    if W >= 96:
        side = 36
        R = W - side - 2
        left = build_bill(S, side) + build_context(S, side)
        flow = build_flow(S, R, tick)
        share_rows = len(left) - len(flow) - 2
        if share_rows >= 2:
            flow += build_share(S, R, share_rows)
        return hconcat([left, flow], [side, R])
    lines = build_flow(S, W, tick)
    if W >= 72:
        half = (W - 2) // 2
        return lines + hconcat([build_bill(S, half), build_context(S, W - half - 2)], [half, W - half - 2])
    return lines + build_bill(S, W) + build_context(S, W)


# (agent rows, two-line agents, task rows, log rows, timeline lanes) from richest to leanest
LEVELS = [(12, True, 8, 8, 6), (10, True, 6, 6, 5), (8, True, 5, 5, 4), (7, False, 4, 4, 3),
          (6, False, 3, 3, 0), (5, False, 3, 0, 0), (4, False, 2, 0, 0), (3, False, 0, 0, 0)]


def build_bottom(S, W, level, tick):
    a_rows, two, t_rows, l_rows, lanes = level
    out = build_agents(S, W, a_rows, two, tick)
    if t_rows:
        out += build_tasks(S, W, t_rows, tick)
    if lanes:
        out += build_timeline(S, W, min(lanes, 1 + len(S["agents"])))
    if l_rows:
        out += build_log(S, W, l_rows)
    return out


def build_frame(S, cols, rows, tick, watch):
    W = max(40, min(cols - 1, 160))
    top = build_header(S, W, tick) + build_top(S, W, tick)
    status = build_status(S, W, tick, watch)
    bottom = []
    for level in (LEVELS if watch else LEVELS[:1]):
        bottom = build_bottom(S, W, level, tick)
        if not watch or len(top) + len(bottom) + 1 <= rows:
            break
    lines = top + bottom
    if watch and len(lines) + 1 > rows:
        lines = lines[:max(0, rows - 1)]
    return lines + [status]


# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    args = sys.argv[1:]
    watch_mode = ("--watch" in args) or ("-w" in args)
    custom_paths = [a for a in args if not a.startswith("-")]
    target_cwd = Path(custom_paths[0]).resolve() if custom_paths else Path.cwd()

    proj_dir = find_claude_project_dir(target_cwd)
    if not proj_dir:
        print(f"{C_GOLD}No Claude Code logs found for: {target_cwd}{RESET}")
        print("Run 'claude' in this directory at least once.")
        sys.exit(1)

    mon = Monitor()
    tick = 0
    if watch_mode:
        sys.stdout.write(ALT_ON + HIDE_CURSOR)
    try:
        while True:
            cols, rows = shutil.get_terminal_size((120, 40))
            session = get_latest_session(proj_dir)
            if session:
                S = mon.collect(session, target_cwd)
                lines = build_frame(S, cols, rows, tick, watch_mode)
            else:
                lines = [f"{C_GOLD}No session recorded yet.{RESET}"]

            if watch_mode:
                sys.stdout.write(HOME + "\n".join(line + CLR_EOL for line in lines) + CLR_EOS)
                sys.stdout.flush()
                tick += 1
                time.sleep(1)
            else:
                print("\n".join(lines))
                break
    except KeyboardInterrupt:
        pass
    finally:
        if watch_mode:
            sys.stdout.write(SHOW_CURSOR + ALT_OFF)
            sys.stdout.flush()


if __name__ == "__main__":
    main()
