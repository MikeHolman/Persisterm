# Persisterm — Persistent Terminals for VS Code

**Never lose a running process to an SSH disconnect again.**

Persisterm backs every terminal with a [tmux](https://github.com/tmux/tmux) session.  When your SSH connection drops (or you close VS Code), the tmux sessions keep running on the remote host.  The next time you connect, the extension automatically detects the surviving sessions and re-creates terminal tabs that reattach to them — running processes, scroll-back, and all.

## How it works

```
 VS Code Terminal tab       proxy       tmux session
┌─────────────────────┐   ┌───────┐   ┌──────────────────┐
│  Persist: 0         │◄─►│ proxy │◄─►│ persisterm-…-0   │
│  Persist: 1         │◄─►│ proxy │◄─►│ persisterm-…-1   │
└─────────────────────┘   └───────┘   └──────────────────┘
         │                                     │
    (disconnect)                          (keeps running)
         │                                     │
    (reconnect)                                │
         │                                     │
┌─────────────────────┐   ┌───────┐            │
│  Persist: 0 (with   │◄─►│ proxy │◄───────────┘
│   scrollback!)      │   └───────┘
└─────────────────────┘
```

A lightweight Python proxy bridges VS Code's terminal and tmux's **control mode** (`-CC`).  Program output flows through VS Code's native terminal renderer, giving you **native scrollback, selection, and search**.  tmux runs in the background purely for session persistence.

1. **New terminal** → proxy connects to tmux in control mode
2. **SSH drops** → proxy dies, tmux session stays alive on the host
3. **Reconnect** → proxy replays tmux scrollback into VS Code, then resumes live output

## Requirements

- **tmux** must be installed on the remote (or local) machine.
  The extension will prompt you to install it if it's missing.
- **Python 3** must be available (used by the control-mode proxy).
  This is pre-installed on virtually all Linux systems.

## Quick start

1. Install the extension (or load it from the `.vsix`).
2. Open the Command Palette → **Persisterm: New Persistent Terminal**.
3. Or select **Persistent Terminal (tmux)** from the terminal profile dropdown (the `+▾` button).
4. Work as normal.  If you get disconnected, just reconnect — your terminals reappear automatically.

## Commands

| Command | Description |
|---------|-------------|
| `Persisterm: New Persistent Terminal` | Create a new tmux-backed terminal |
| `Persisterm: Reattach All Sessions` | Manually reattach to any orphaned sessions |
| `Persisterm: Kill All Persistent Sessions` | Destroy all tmux sessions managed by this extension |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `persisterm.autoReattach` | `true` | Automatically reattach to surviving sessions on startup |
| `persisterm.sessionPrefix` | `"persisterm"` | Base prefix for tmux session names. Workspaces with a folder are isolated automatically. |
| `persisterm.showStatusBar` | `true` | Show the persistent-session count in the status bar |

## Keyboard shortcut

`Ctrl+Shift+`` — create a new persistent terminal (customisable in Keyboard Shortcuts).

## Tips

- **Scrollback just works**: unlike a regular tmux attach, Persisterm uses
  tmux's control mode so output flows through VS Code's native terminal.
  Scroll, select, and search work exactly like a normal terminal.
  On reconnect, previous output is replayed into the scrollback.

- **Make it the default terminal**: open Settings and set  
  `terminal.integrated.defaultProfile.linux` to `Persistent Terminal (tmux)`.  
  Every new terminal will then be tmux-backed automatically.

- **Your normal remote shell is preserved**: Persisterm uses the remote
  account's `$SHELL` (falling back to its passwd login shell) instead of
  hardcoding Bash. Bash login profiles, Zsh's `.zshenv`/`.zprofile`/`.zshrc`/
  `.zlogin`, and Fish's login configuration run in their normal order, while a
  prompt hook refreshes VS Code integration variables. If a Bash profile sets
  `PROMPT_COMMAND`, it should append to (rather than replace) the inherited
  value. Existing panes keep the shell they were created with; open a new
  terminal after changing `$SHELL` or upgrading from an older version.

- **Multiple workspaces on one host are isolated automatically**: Persisterm
  adds a short hash of the first workspace folder URI to the session prefix.
  Folderless windows keep using the global prefix and can reattach to legacy
  sessions such as `persisterm-0`.

- **Intentional close vs. disconnect**: closing a terminal tab in VS Code
  kills the underlying tmux session (to avoid leaks).  Disconnecting leaves
  sessions alive for reattachment.

## Building from source

```bash
cd persisterm
npm install
npm run compile                    # one-shot build
npm run watch                      # incremental rebuild
npm test                           # shell startup + tmux integration tests
npm run lint                       # TypeScript ESLint checks
npm run package                    # produces a .vsix
```

## License

MIT
