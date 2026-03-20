/**
 * tmux.ts — thin wrapper around tmux CLI for session lifecycle management.
 *
 * All functions are synchronous (execSync) because they are fast local
 * operations and the VS Code terminal API that consumes them is synchronous.
 *
 * Every tmux invocation uses a dedicated socket (`-L persisterm`) so that
 * persistent terminals are fully isolated from the user's own tmux sessions.
 * A custom config file disables the status bar, turns off the alternate
 * screen buffer (so that VS Code's native scrollback works normally), and
 * eliminates the escape-key delay.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/* ------------------------------------------------------------------ */
/*  Dedicated socket & configuration                                   */
/* ------------------------------------------------------------------ */

/** Socket name — keeps persisterm sessions separate from user tmux. */
export const SOCKET = "persisterm";

const CONFIG_DIR = path.join(os.homedir(), ".config", "persisterm");
const CONFIG_PATH = path.join(CONFIG_DIR, "tmux.conf");
const VSCODE_ENV_PATH = path.join(CONFIG_DIR, "vscode-env");
const SHELL_INIT_PATH = path.join(CONFIG_DIR, "shell-init.sh");
const PROXY_PATH = path.join(CONFIG_DIR, "tmux-proxy.py");

/**
 * Environment variables that VS Code sets for its integrated terminal
 * and that must be propagated into tmux sessions so that `code --wait`,
 * git credential helpers, and other VS Code integrations keep working
 * across reconnects.
 */
const VSCODE_ENV_VARS = [
  "VSCODE_IPC_HOOK_CLI",
  "VSCODE_GIT_ASKPASS_NODE",
  "VSCODE_GIT_ASKPASS_MAIN",
  "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
];

/**
 * Minimal tmux config that makes the tmux layer as transparent as
 * possible inside a VS Code terminal panel.
 */
const TMUX_CONFIG = `\
# Persisterm tmux configuration
# Auto-generated on every activation — manual edits will be overwritten.

# Hide the tmux status bar (VS Code already shows which terminal is active)
set-option -g status off

# Zero escape-key delay (critical for vim / emacs users)
set-option -g escape-time 0

# ── Scrollback ───────────────────────────────────────────────────────
# Generous scrollback inside tmux.  The proxy uses capture-pane to
# replay this buffer into VS Code's native scrollback on reconnect.
set-option -g history-limit 50000

# ── VS Code integration ─────────────────────────────────────────────
# When a client attaches, automatically update the session environment
# with VSCODE_* variables from the attaching client.
set-option -g update-environment "VSCODE_IPC_HOOK_CLI VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_EXTRA_ARGS"

# Start every shell via our init script which sources ~/.bashrc followed
# by vscode-env, keeping the PROMPT_COMMAND hook alive in the shell.
set-option -g default-command "bash --rcfile \${CONFIG_SHELL_INIT}"
`;

/**
 * Resolve the config template: CONFIG_VSCODE_ENV placeholder needs to
 * be replaced at runtime because the path depends on $HOME.
 */
function resolvedTmuxConfig(): string {
  return TMUX_CONFIG
    .replace(
      /\$\{CONFIG_VSCODE_ENV\}/g,
      VSCODE_ENV_PATH.replace(/'/g, "'\\'"),
    )
    .replace(
      /\$\{CONFIG_SHELL_INIT\}/g,
      SHELL_INIT_PATH.replace(/'/g, "'\\'"),
    );
}


/**
 * Write (or overwrite) the persisterm tmux config file.
 * Call once during extension activation.
 */
export function ensureConfig(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const newConfig = resolvedTmuxConfig();

  // If the config changed, kill the running tmux server so it restarts
  // with the new config.  Sessions survive a config-only restart because
  // `kill-server` is not used — we rely on the server picking up the new
  // config file on the next `new-session` invocation.  However, a major
  // config change (like switching from mouse-mode to control-mode proxy)
  // can leave a server whose runtime state is incompatible.  Detect this
  // by comparing the on-disk config with the new one.
  let configChanged = false;
  try {
    const existing = fs.readFileSync(CONFIG_PATH, "utf-8");
    configChanged = existing !== newConfig;
  } catch {
    configChanged = true; // no existing config
  }

  fs.writeFileSync(CONFIG_PATH, newConfig, { encoding: "utf-8" });

  if (configChanged) {
    // Kill the running server so it restarts with the new config.
    // Sessions are lost, but this only happens on extension upgrades.
    try {
      execSync(`tmux -L ${SOCKET} kill-server 2>/dev/null`, { stdio: "pipe" });
    } catch { /* server wasn't running — fine */ }
  }

  // Clean up stale tmux socket if the server is dead.  A stale socket
  // causes tmux to fail with "server exited unexpectedly" (exit code 1).
  try {
    execSync(`tmux -L ${SOCKET} list-sessions 2>/dev/null`, { stdio: "pipe" });
  } catch {
    // Server isn't running — remove the socket if it exists.
    const socketDir = `/tmp/tmux-${process.getuid!()}`;
    const socketPath = path.join(socketDir, SOCKET);
    try {
      fs.unlinkSync(socketPath);
    } catch { /* socket doesn't exist — fine */ }
  }

  // Shell init script: sources the user's bashrc, then our env file.
  // This ensures the PROMPT_COMMAND hook and _persisterm_refresh function
  // live in the interactive shell (not killed by exec).
  const shellInit = [
    "#!/bin/bash",
    "# Auto-generated by Persisterm — do not edit.",
    "",
    "# Source the user's normal bashrc first.",
    `[ -f ~/.bashrc ] && . ~/.bashrc`,
    "",
    "# Then install VS Code env vars + auto-refresh hook.",
    `. '${VSCODE_ENV_PATH.replace(/'/g, "'\\''")}'  2>/dev/null`,
  ].join("\n") + "\n";
  fs.writeFileSync(SHELL_INIT_PATH, shellInit, { encoding: "utf-8" });
}

/**
 * Write the tmux control-mode proxy script to the config directory.
 *
 * The proxy bridges VS Code's terminal pty and tmux's control mode,
 * giving native VS Code scrollback while tmux handles persistence.
 */
export function ensureProxy(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const src = path.join(__dirname, "..", "src", "tmux-proxy.py");
  // Try reading from the source tree first (development), then fall
  // back to reading from next to the compiled JS (packaged extension).
  let content: string;
  try {
    content = fs.readFileSync(src, "utf-8");
  } catch {
    const alt = path.join(__dirname, "tmux-proxy.py");
    content = fs.readFileSync(alt, "utf-8");
  }
  fs.writeFileSync(PROXY_PATH, content, { encoding: "utf-8", mode: 0o755 });
}

/**
 * Write the VS Code env helper script.  Instead of snapshotting static
 * values (which go stale after a reload — process.env is never updated),
 * the script dynamically resolves the newest IPC socket and the other
 * VSCODE_* variables every time it's sourced.
 *
 * A PROMPT_COMMAND hook re-runs the resolution on every prompt, so the
 * running shell always has the correct socket — even after a VS Code
 * reconnect — with zero visible output.
 */
export function writeVscodeEnv(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Detect the XDG_RUNTIME_DIR (where sockets live).  Usually /run/user/<uid>.
  const runtimeDir = process.env["XDG_RUNTIME_DIR"] || `/run/user/${process.getuid!()}`;

  const lines = [
    "#!/bin/sh",
    "# Auto-generated by Persisterm — do not edit.",
    "# Sourced inside tmux sessions to keep VS Code integrations working.",
    "",
    "# --- Dynamically resolve the newest VS Code IPC socket ---",
    `_persisterm_sock=$(ls -t '${runtimeDir}'/vscode-ipc-*.sock 2>/dev/null | head -1)`,
    `if [ -n "$_persisterm_sock" ]; then`,
    `  export VSCODE_IPC_HOOK_CLI="$_persisterm_sock"`,
    `fi`,
    "",
    "# --- Static values for git credential helpers ---",
  ];

  // These rarely change across reloads, so static values are fine.
  for (const key of VSCODE_ENV_VARS) {
    if (key === "VSCODE_IPC_HOOK_CLI") {
      continue; // handled dynamically above
    }
    const val = process.env[key];
    if (val !== undefined) {
      lines.push(`export ${key}='${val.replace(/'/g, "'\\''")}'`);
    }
  }

  // Install a PROMPT_COMMAND hook that re-resolves the socket on every
  // prompt.  This ensures the running shell always has the correct
  // socket even if VS Code reconnects or creates a new IPC socket.
  //
  // We always (re-)define the function and PROMPT_COMMAND — no guard.
  // Shell functions and plain variables don't survive `exec` or new
  // shells, even though _PERSISTERM_HOOK (exported) does.  Re-defining
  // is harmless; *not* re-defining leaves PROMPT_COMMAND empty.
  lines.push("");
  lines.push(`_persisterm_refresh() {`);
  lines.push(`  _s=$(ls -t '${runtimeDir}'/vscode-ipc-*.sock 2>/dev/null | head -1)`);
  lines.push(`  [ -n "$_s" ] && export VSCODE_IPC_HOOK_CLI="$_s"`);
  lines.push(`}`);
  lines.push(`# Prepend our refresh, keeping any existing PROMPT_COMMAND.`);
  lines.push(`case "$PROMPT_COMMAND" in`);
  lines.push(`  *_persisterm_refresh*) ;;  # already present`);
  lines.push(`  *) PROMPT_COMMAND="_persisterm_refresh\${PROMPT_COMMAND:+;\\$PROMPT_COMMAND}" ;;`);
  lines.push(`esac`);

  fs.writeFileSync(VSCODE_ENV_PATH, lines.join("\n") + "\n", {
    encoding: "utf-8",
  });
}

/** Common prefix for every tmux CLI invocation. */
function baseCmd(): string {
  return `tmux -f ${esc(CONFIG_PATH)} -L ${SOCKET}`;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface TmuxSession {
  name: string;
  /** Number of clients currently attached to this session. */
  attached: number;
  windows: number;
  /** Unix epoch seconds when the session was created. */
  created: number;
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

/** Return `true` when the `tmux` binary is on $PATH. */
export function isInstalled(): boolean {
  try {
    execSync("command -v tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Return the tmux version as a numeric tuple, e.g. [3, 4] for "3.4". */
export function version(): [number, number] | undefined {
  try {
    const raw = execSync("tmux -V", { encoding: "utf-8", stdio: "pipe" }).trim();
    const m = raw.match(/(\d+)\.(\d+)/);
    if (m) {
      return [parseInt(m[1], 10), parseInt(m[2], 10)];
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * List every tmux session whose name starts with `prefix`.
 * Returns an empty array when the tmux server is not running.
 */
export function listSessions(prefix: string): TmuxSession[] {
  try {
    const raw = execSync(
      `${baseCmd()} list-sessions -F "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return raw
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((line) => {
        const [name, attached, windows, created] = line.split("|");
        return {
          name,
          attached: parseInt(attached, 10),
          windows: parseInt(windows, 10),
          created: parseInt(created, 10),
        };
      })
      .filter((s) => s.name.startsWith(prefix));
  } catch {
    return [];
  }
}

/** Check whether a specific tmux session exists. */
export function hasSession(name: string): boolean {
  try {
    execSync(`${baseCmd()} has-session -t ${esc(name)} 2>/dev/null`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

/** Kill a single tmux session.  Returns `true` on success. */
export function killSession(name: string): boolean {
  try {
    execSync(`${baseCmd()} kill-session -t ${esc(name)}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Find the lowest non-negative integer N such that
 * `${prefix}-${N}` does not already exist as a tmux session.
 */
export function nextIndex(prefix: string): number {
  const sessions = listSessions(prefix);
  const taken = new Set(
    sessions
      .map((s) => {
        const m = s.name.match(
          new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`),
        );
        return m ? parseInt(m[1], 10) : -1;
      })
      .filter((i) => i >= 0),
  );
  let i = 0;
  while (taken.has(i)) {
    i++;
  }
  return i;
}

/**
 * Build the shell invocation that creates-or-attaches a tmux session
 * via the control-mode proxy.
 *
 * The proxy script (`tmux-proxy.py`) uses tmux's `-CC` control mode to
 * bridge between VS Code's terminal pty and the tmux session.  This
 * gives native VS Code scrollback while tmux handles persistence.
 *
 * Before launching the proxy we:
 *   1. Source the VS Code env file (so env vars propagate to tmux).
 *   2. For existing sessions, push each env var into the tmux session
 *      via `tmux set-environment` (completely invisible).
 *
 * When `reattach` is true the proxy dumps the pane's scrollback history
 * into VS Code's terminal before connecting, so the user sees their
 * previous output in the native scrollback.
 *
 * An auto-reconnect loop wraps the proxy invocation: if the proxy
 * exits unexpectedly but the tmux session is still alive (e.g. a
 * transient error during reconnection), the shell retries up to 5
 * times with a one-second delay between attempts.  `--reattach` is
 * only passed on the first attempt (scrollback was already replayed).
 */
export function shellCommand(
  sessionName: string,
  reattach = false,
): {
  shellPath: string;
  shellArgs: string[];
} {
  const base = `tmux -f ${esc(CONFIG_PATH)} -L ${SOCKET}`;
  const envFile = esc(VSCODE_ENV_PATH);
  const sess = esc(sessionName);

  // Build set-environment commands for each tracked variable.
  const setEnvCmds = VSCODE_ENV_VARS.map(
    (v) => `    ${base} set-environment -t ${sess} ${v} "\$${v}" 2>/dev/null`,
  ).join("\n");

  const proxyArgs = [
    esc(PROXY_PATH),
    sess,
    "--socket", SOCKET,
    "--config", esc(CONFIG_PATH),
  ];
  const proxyCmd = `python3 ${proxyArgs.join(" ")}`;
  // First attempt may replay scrollback history.
  const firstCmd = reattach ? `${proxyCmd} --reattach` : proxyCmd;

  const cmd = [
    // Exit cleanly on SIGTERM/SIGHUP (VS Code closing the terminal tab).
    `trap 'exit 0' TERM HUP`,
    // 1. Source VS Code env into this shell
    `. ${envFile} 2>/dev/null`,
    // 2. If session exists, silently push env vars into the session
    `if ${base} has-session -t ${sess} 2>/dev/null; then`,
    setEnvCmds,
    `fi`,
    // 3. Launch the proxy (first attempt may replay scrollback)
    firstCmd,
    // 4. Auto-reconnect: if the proxy exits but the tmux session is
    //    still alive, the connection was interrupted — retry.
    `_pn=0`,
    `while ${base} has-session -t ${sess} 2>/dev/null; do`,
    `  _pn=$((_pn + 1))`,
    `  [ $_pn -ge 5 ] && printf '\\033[33mPersisterm: giving up after 5 reconnect attempts.\\033[0m\\n' && break`,
    `  printf '\\033[33mPersisterm: reconnecting (attempt %d/5)...\\033[0m\\n' "$_pn"`,
    `  sleep 1`,
    `  ${proxyCmd}`,
    `done`,
  ].join("\n");

  return {
    shellPath: "sh",
    shellArgs: ["-c", cmd],
  };
}

/* ------------------------------------------------------------------ */
/*  Internal utilities                                                 */
/* ------------------------------------------------------------------ */

/** Shell-escape a session name for use in tmux CLI invocations. */
function esc(name: string): string {
  // Session names are alphanumeric + dash in our scheme, but be safe.
  return `'${name.replace(/'/g, "'\\''")}'`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
