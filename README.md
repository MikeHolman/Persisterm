# Persisterm — Persistent Terminals for VS Code

**Never lose a running process to an SSH disconnect again.**

Persisterm backs every terminal with a [tmux](https://github.com/tmux/tmux) session.  When your SSH connection drops (or you close VS Code), the tmux sessions keep running on the remote host.  The next time you connect, the extension automatically detects the surviving sessions and re-creates terminal tabs that reattach to them — running processes, scroll-back, and all.

## How it works

```
 VS Code Terminal tab          tmux session
┌─────────────────────┐       ┌──────────────────┐
│  Persist: 0         │ ───── │  persisterm-0    │
│  Persist: 1         │ ───── │  persisterm-1    │
└─────────────────────┘       └──────────────────┘
         │                             │
    (disconnect)                  (keeps running)
         │                             │
    (reconnect)                        │
         │                             │
┌─────────────────────┐               │
│  Persist: 0 ◄───────────────────────┘
│  Persist: 1 ◄───────────────────────
└─────────────────────┘
```

1. **New terminal** → `tmux new-session -A -s persisterm-N`
2. **SSH drops** → tmux client dies, session stays alive on the host
3. **Reconnect** → extension lists `persisterm-*` sessions, opens terminals that reattach

## Requirements

- **tmux** must be installed on the remote (or local) machine.
  The extension will prompt you to install it if it's missing.

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
| `persisterm.sessionPrefix` | `"persisterm"` | Prefix for tmux session names.  Change this if you run multiple workspaces on the same host to keep sessions separate. |
| `persisterm.showStatusBar` | `true` | Show the persistent-session count in the status bar |

## Keyboard shortcut

`Ctrl+Shift+`` — create a new persistent terminal (customisable in Keyboard Shortcuts).

## Tips

- **Make it the default terminal**: open Settings and set  
  `terminal.integrated.defaultProfile.linux` to `Persistent Terminal (tmux)`.  
  Every new terminal will then be tmux-backed automatically.

- **Multiple workspaces on one host**: set a unique `persisterm.sessionPrefix`
  per workspace (e.g. `proj-a`, `proj-b`) to avoid cross-talk.

- **Intentional close vs. disconnect**: closing a terminal tab in VS Code
  kills the underlying tmux session (to avoid leaks).  Disconnecting leaves
  sessions alive for reattachment.

## Building from source

```bash
cd persisterm
npm install
npm run compile          # one-shot build
npm run watch            # incremental rebuild
npm run package          # produces a .vsix
```

## License

MIT
