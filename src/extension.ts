/**
 * Persisterm – Persistent Terminals for VS Code
 *
 * Every terminal opened through this extension is backed by a tmux session.
 * When VS Code disconnects (SSH drop, window close, etc.) the tmux sessions
 * keep running.  On the next connection the extension discovers the surviving
 * sessions and re-creates VS Code terminal panels that attach to them, so
 * the user picks up right where they left off – running processes and all.
 *
 * Key design decisions
 * ────────────────────
 * • `tmux new-session -A -s <name>` is used for both creation and reattach.
 *   The -A flag means "attach if the session exists, otherwise create it."
 *
 * • An `isDeactivating` flag prevents the `onDidCloseTerminal` handler from
 *   killing tmux sessions during a graceful VS Code shutdown.  On an
 *   ungraceful disconnect the extension host is killed outright so the
 *   handler never runs — tmux sessions survive either way.
 *
 * • When the user intentionally closes a terminal tab (not a disconnect),
 *   we *do* kill the underlying tmux session to avoid unbounded leaks.
 */

import * as vscode from "vscode";
import * as tmux from "./tmux";

/* ------------------------------------------------------------------ */
/*  Module-level state                                                 */
/* ------------------------------------------------------------------ */

/**
 * Set to `true` inside `deactivate()` so that the terminal-close handler
 * knows *not* to kill tmux sessions (they must survive for reattach).
 */
let isDeactivating = false;

/**
 * True during the restoration window (first few seconds after activation).
 * While true, the profile provider records any sessions it creates so we
 * can dispose the associated terminals and kill the ghost sessions later.
 */
let isRestoring = true;

/**
 * tmux session names created by the profile provider during the
 * restoration window.  These are "ghost" sessions — the profile
 * provider was called because VS Code tried to restore old terminal
 * tabs, but each call allocates a **new** tmux session instead of
 * reattaching to the original one.  We kill them after the window
 * closes and create proper terminals for the real surviving sessions.
 */
const ghostSessions = new Set<string>();

/**
 * Sessions that the profile provider successfully reattached to during
 * the restoration window.  These don't need `reattachOrphans` to handle.
 */
const restoredSessions = new Set<string>();

/**
 * Terminals we are programmatically disposing (ghosts or duplicates).
 * The onDidCloseTerminal handler must not kill the tmux session for these.
 */
const disposingDuplicates = new Set<vscode.Terminal>();

/** tmux session name  →  VS Code Terminal object */
const sessionToTerminal = new Map<string, vscode.Terminal>();
/** VS Code Terminal object  →  tmux session name */
const terminalToSession = new Map<vscode.Terminal, string>();

/**
 * Delayed kill timers.  When the user closes a terminal tab we don’t
 * kill the tmux session immediately — we schedule it after a short
 * delay.  If `deactivate()` fires during that window (VS Code is
 * shutting down), we cancel all pending kills so the sessions survive.
 */
const pendingKills = new Map<string, ReturnType<typeof setTimeout>>();

/* ------------------------------------------------------------------ */
/*  Configuration helpers                                              */
/* ------------------------------------------------------------------ */

interface Config {
  autoReattach: boolean;
  sessionPrefix: string;
  showStatusBar: boolean;
}

function cfg(): Config {
  const c = vscode.workspace.getConfiguration("persisterm");
  return {
    autoReattach: c.get<boolean>("autoReattach", true),
    sessionPrefix: c.get<string>("sessionPrefix", "persisterm"),
    showStatusBar: c.get<boolean>("showStatusBar", true),
  };
}

/** The profile title registered in package.json. */
const PROFILE_TITLE = "Persistent Terminal (tmux)";

/**
 * Return the platform-specific VS Code setting key for the default
 * terminal profile.
 */
function defaultProfileSettingKey(): string {
  switch (process.platform) {
    case "darwin":
      return "defaultProfile.osx";
    case "win32":
      return "defaultProfile.windows";
    default:
      return "defaultProfile.linux";
  }
}

/**
 * On first activation, if the user hasn't already chosen our profile as
 * the default terminal, offer to set it via the built-in
 * `terminal.integrated.defaultProfile.*` setting.  The prompt is shown
 * at most once (tracked via global state).
 */
async function offerDefaultProfile(
  context: vscode.ExtensionContext,
): Promise<void> {
  const PROMPTED_KEY = "persisterm.offeredDefaultProfile";
  if (context.globalState.get<boolean>(PROMPTED_KEY)) {
    return;
  }

  const termCfg = vscode.workspace.getConfiguration("terminal.integrated");
  const key = defaultProfileSettingKey();
  const current = termCfg.get<string>(key);

  // Already the default — nothing to ask.
  if (current === PROFILE_TITLE) {
    await context.globalState.update(PROMPTED_KEY, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Would you like to make Persistent Terminal (tmux) your default terminal profile?",
    "Yes",
    "No",
  );

  // Remember that we asked regardless of answer.
  await context.globalState.update(PROMPTED_KEY, true);

  if (choice === "Yes") {
    await termCfg.update(key, PROFILE_TITLE, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      `Default terminal profile set to "${PROFILE_TITLE}". You can change this anytime in Settings → terminal.integrated.${key}.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Terminal lifecycle                                                  */
/* ------------------------------------------------------------------ */

/**
 * Create (or reattach to) a persistent terminal backed by the given tmux
 * session.  If `sessionName` is omitted a new session index is allocated.
 */
function createPersistentTerminal(sessionName?: string): vscode.Terminal {
  const { sessionPrefix } = cfg();

  if (!sessionName) {
    const idx = tmux.nextIndex(sessionPrefix);
    sessionName = `${sessionPrefix}-${idx}`;
  }

  // If we already track a VS Code terminal for this session, just show it.
  const existing = sessionToTerminal.get(sessionName);
  if (existing) {
    existing.show();
    return existing;
  }

  const { shellPath, shellArgs } = tmux.shellCommand(sessionName);

  const terminal = vscode.window.createTerminal({
    name: formatTerminalName(sessionName),
    shellPath,
    shellArgs,
  });

  track(sessionName, terminal);
  return terminal;
}

/**
 * Scan for tmux sessions that have our prefix but no corresponding VS Code
 * terminal, and reattach to each one.  Returns the number of sessions
 * restored.
 */
function reattachOrphans(): number {
  const { sessionPrefix } = cfg();
  const sessions = tmux.listSessions(sessionPrefix);
  let count = 0;
  for (const s of sessions) {
    // Skip if already tracked or already restored via profile provider.
    if (sessionToTerminal.has(s.name) || restoredSessions.has(s.name)) {
      continue;
    }
    createPersistentTerminal(s.name);
    count++;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/*  Tracking helpers                                                   */
/* ------------------------------------------------------------------ */

function track(sessionName: string, terminal: vscode.Terminal): void {
  sessionToTerminal.set(sessionName, terminal);
  terminalToSession.set(terminal, sessionName);
}

function untrack(terminal: vscode.Terminal): string | undefined {
  const name = terminalToSession.get(terminal);
  if (name !== undefined) {
    terminalToSession.delete(terminal);
    sessionToTerminal.delete(name);
  }
  return name;
}

/** Derive a human-readable VS Code terminal tab title. */
function formatTerminalName(sessionName: string): string {
  // "persisterm-3" → "Persist: 3"
  const parts = sessionName.split("-");
  const idx = parts[parts.length - 1];
  return `Persist: ${idx}`;
}

/* ------------------------------------------------------------------ */
/*  Ghost session cleanup                                              */
/* ------------------------------------------------------------------ */

/**
 * Dispose VS Code terminals and kill tmux sessions that were created
 * by the profile provider during VS Code's terminal restoration.
 *
 * Why this is needed: when VS Code restores saved terminal tabs it
 * calls `provideTerminalProfile()` for each one.  Each call allocates
 * a **new** tmux session (e.g. persisterm-5) instead of reattaching to
 * the original (e.g. persisterm-0).  These "ghost" sessions must be
 * cleaned up before we create proper terminals for the real survivors.
 */
function cleanupGhostSessions(): void {
  for (const name of ghostSessions) {
    const terminal = sessionToTerminal.get(name);
    if (terminal) {
      disposingDuplicates.add(terminal);
      untrack(terminal);
      terminal.dispose();
    }
    tmux.killSession(name);
  }
  ghostSessions.clear();
}

/* ------------------------------------------------------------------ */
/*  Status bar                                                         */
/* ------------------------------------------------------------------ */

function makeStatusBar(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    -100,
  );
  item.command = "persisterm.newTerminal";
  return item;
}

function refreshStatusBar(item: vscode.StatusBarItem): void {
  const { sessionPrefix, showStatusBar } = cfg();
  if (!showStatusBar) {
    item.hide();
    return;
  }
  const n = tmux.listSessions(sessionPrefix).length;
  item.text = `$(terminal) ${n} persistent`;
  item.tooltip = `${n} tmux-backed terminal session(s)\nClick to create a new one`;
  item.show();
}

/* ------------------------------------------------------------------ */
/*  Activation / deactivation                                          */
/* ------------------------------------------------------------------ */

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  isDeactivating = false;

  /* ---- tmux gate check ---- */
  if (!tmux.isInstalled()) {
    const choice = await vscode.window.showErrorMessage(
      "Persisterm requires tmux but it was not found on this machine.",
      "Try installing tmux",
    );
    if (choice) {
      const t = vscode.window.createTerminal("Install tmux");
      t.show();
      t.sendText(
        "sudo apt-get update && sudo apt-get install -y tmux || sudo dnf install -y tmux || sudo pacman -S --noconfirm tmux || brew install tmux",
      );
    }
    return; // nothing else we can do until tmux is available
  }

  /* ---- write tmux config for transparent operation ---- */
  tmux.ensureConfig();

  /* ---- minimize VS Code scrollback (tmux handles scrolling) ---- */
  // tmux virtualises the screen so VS Code's own scrollback is always
  // empty.  Setting it to the minimum hides the misleading scrollbar.
  {
    const termCfg = vscode.workspace.getConfiguration("terminal.integrated");
    const inspected = termCfg.inspect<number>("scrollback");
    if (
      inspected &&
      inspected.globalValue === undefined &&
      inspected.workspaceValue === undefined &&
      inspected.workspaceFolderValue === undefined
    ) {
      termCfg.update("scrollback", 0, vscode.ConfigurationTarget.Global);
    }
  }

  /* ---- snapshot VS Code env vars for tmux sessions ---- */
  tmux.writeVscodeEnv();

  /* ---- terminal profile provider ---- */
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(
      "persisterm.terminalProfile",
      {
        provideTerminalProfile(
          _token: vscode.CancellationToken,
        ): vscode.ProviderResult<vscode.TerminalProfile> {
          const { sessionPrefix } = cfg();

          if (isRestoring) {
            // During the restoration window VS Code re-invokes the
            // profile provider to restore saved terminal tabs.  Instead
            // of creating a new tmux session (which would be a ghost),
            // find the next *existing* unassigned session and reattach.
            const existing = tmux.listSessions(sessionPrefix);
            const unassigned = existing.find(
              (s) => !sessionToTerminal.has(s.name) && !restoredSessions.has(s.name),
            );
            if (unassigned) {
              restoredSessions.add(unassigned.name);
              const { shellPath, shellArgs } = tmux.shellCommand(unassigned.name);
              return new vscode.TerminalProfile({
                name: formatTerminalName(unassigned.name),
                shellPath,
                shellArgs,
              });
            }
            // No existing session to reuse — fall through to create one
            // but mark it as a ghost so it gets cleaned up.
            const idx = tmux.nextIndex(sessionPrefix);
            const sessionName = `${sessionPrefix}-${idx}`;
            ghostSessions.add(sessionName);
            const { shellPath, shellArgs } = tmux.shellCommand(sessionName);
            return new vscode.TerminalProfile({
              name: formatTerminalName(sessionName),
              shellPath,
              shellArgs,
            });
          }

          // Normal (non-restoring) path — create a brand new session.
          const idx = tmux.nextIndex(sessionPrefix);
          const sessionName = `${sessionPrefix}-${idx}`;
          const { shellPath, shellArgs } = tmux.shellCommand(sessionName);
          return new vscode.TerminalProfile({
            name: formatTerminalName(sessionName),
            shellPath,
            shellArgs,
          });
        },
      },
    ),
  );

  /* ---- track terminals opened via the profile provider or reattach ---- */
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      // If we already track it (created via createPersistentTerminal), skip.
      if (terminalToSession.has(terminal)) {
        return;
      }
      // Check whether the name matches our pattern.
      const match = terminal.name.match(/^Persist: (.+)$/);
      if (match) {
        const { sessionPrefix } = cfg();
        const sessionName = `${sessionPrefix}-${match[1]}`;
        if (!sessionToTerminal.has(sessionName)) {
          track(sessionName, terminal);
        }
        // If already tracked — the ghost cleanup or reattachOrphans will
        // sort it out.  Don't dispose here to avoid races.
      }
    }),
  );

  /* ---- commands ---- */
  context.subscriptions.push(
    vscode.commands.registerCommand("persisterm.newTerminal", () => {
      createPersistentTerminal().show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("persisterm.reattachAll", () => {
      const n = reattachOrphans();
      vscode.window.showInformationMessage(
        n > 0
          ? `Persisterm: reattached to ${n} session(s).`
          : "Persisterm: no orphaned sessions found.",
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "persisterm.killAllSessions",
      async () => {
        const { sessionPrefix } = cfg();
        const sessions = tmux.listSessions(sessionPrefix);
        if (sessions.length === 0) {
          vscode.window.showInformationMessage(
            "Persisterm: no sessions to kill.",
          );
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `Kill ${sessions.length} persistent session(s)?  Running processes will be lost.`,
          { modal: true },
          "Kill All",
        );
        if (choice !== "Kill All") {
          return;
        }
        for (const s of sessions) {
          tmux.killSession(s.name);
          const t = sessionToTerminal.get(s.name);
          if (t) {
            untrack(t);
            // Dispose the VS Code terminal panel too.
            t.dispose();
          }
        }
        vscode.window.showInformationMessage(
          `Persisterm: killed ${sessions.length} session(s).`,
        );
      },
    ),
  );

  /* ---- clean up tmux when user intentionally closes a tab ---- */
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      // If this is a duplicate we disposed ourselves, just clean up the flag.
      if (disposingDuplicates.delete(terminal)) {
        return;
      }
      const sessionName = untrack(terminal);
      if (sessionName && !isDeactivating) {
        // Schedule the kill after a short delay.  If the window is
        // shutting down, deactivate() will cancel this before it fires.
        const timer = setTimeout(() => {
          pendingKills.delete(sessionName);
          tmux.killSession(sessionName);
        }, 2000);
        pendingKills.set(sessionName, timer);
      }
      // During deactivation we intentionally leave the session alive so
      // that it can be reattached on the next connection.
    }),
  );

  /* ---- status bar ---- */
  const statusBar = makeStatusBar();
  refreshStatusBar(statusBar);
  const timer = setInterval(() => refreshStatusBar(statusBar), 5_000);
  context.subscriptions.push({
    dispose() {
      clearInterval(timer);
      statusBar.dispose();
    },
  });

  /* ---- offer to set as default profile (one-time) ---- */
  offerDefaultProfile(context);

  /* ---- auto-reattach on startup ---- */
  // VS Code restores saved terminal tabs by re-invoking the profile
  // provider, which creates ghost tmux sessions.  We wait for that
  // to finish, then clean up the ghosts and create proper terminals
  // for the real surviving sessions.
  if (cfg().autoReattach) {
    const reattachDelay = 2000; // ms — enough for VS Code to finish restoring
    setTimeout(() => {
      // Close the restoration window.
      isRestoring = false;

      // Kill ghost sessions + their VS Code terminals.
      cleanupGhostSessions();

      // Create fresh terminals for the real surviving sessions.
      const n = reattachOrphans();
      if (n > 0) {
        // Show the first terminal so the panel stays visible.
        const first = [...sessionToTerminal.values()][0];
        if (first) {
          first.show(/* preserveFocus */ true);
        }
        vscode.window.showInformationMessage(
          `Persisterm: restored ${n} persistent terminal(s) from a previous session.`,
        );
      }
      refreshStatusBar(statusBar);
    }, reattachDelay);
  } else {
    // Even without auto-reattach, close the restoration window so
    // future profile provider calls aren't marked as ghosts.
    setTimeout(() => {
      isRestoring = false;
      cleanupGhostSessions();
    }, 2000);
  }
}

export function deactivate(): void {
  // Set the flag so no new kills are scheduled.
  isDeactivating = true;
  // Cancel every pending kill — those tmux sessions must survive
  // for reattach on the next connection.
  for (const timer of pendingKills.values()) {
    clearTimeout(timer);
  }
  pendingKills.clear();
}
