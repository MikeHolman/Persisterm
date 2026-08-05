const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const tmux = require("../out/tmux.js");
const fishPath = spawnSync("sh", ["-c", "command -v fish"], {
  encoding: "utf8",
}).stdout.trim();

function tempLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persisterm-test-"));
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const zsh = path.join(config, "zsh");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(zsh, { recursive: true });
  return {
    root,
    home,
    config,
    zsh,
    env: path.join(config, "vscode-env.sh"),
    launcher: path.join(config, "shell-launcher.sh"),
    fishInit: path.join(config, "fish-init.fish"),
  };
}

function writeGeneratedFiles(layout) {
  const files = tmux.buildShellIntegrationFiles(
    layout.env,
    layout.zsh,
    layout.fishInit,
  );
  fs.writeFileSync(layout.launcher, files.launcher, { mode: 0o755 });
  fs.writeFileSync(path.join(layout.zsh, ".zshenv"), files.zshEnv);
  fs.writeFileSync(path.join(layout.zsh, ".zprofile"), files.zshProfile);
  fs.writeFileSync(path.join(layout.zsh, ".zshrc"), files.zshRc);
  fs.writeFileSync(path.join(layout.zsh, ".zlogin"), files.zshLogin);
  fs.writeFileSync(layout.fishInit, files.fishInit);
  return files;
}

test("tmux config passes the selected user shell to the launcher", () => {
  const config = tmux.buildTmuxConfig("/usr/bin/zsh");
  assert.match(config, /set-option -g default-shell "\/bin\/sh"/);
  assert.match(config, /shell-launcher\.sh.*\/usr\/bin\/zsh/);
  assert.match(config, /set-option -g update-environment .*SSH_AUTH_SOCK.*VSCODE_IPC_HOOK_CLI/);
  assert.doesNotMatch(config, /bash --rcfile/);
});

test("user shell resolution honors SHELL and falls back to passwd shell", () => {
  const original = process.env.SHELL;
  try {
    process.env.SHELL = "/bin/bash";
    assert.equal(tmux.resolveUserShell(), "/bin/bash");

    process.env.SHELL = "/definitely/not/a/shell";
    const passwdShell = os.userInfo().shell;
    const expected = passwdShell && fs.existsSync(passwdShell)
      ? passwdShell
      : "/bin/sh";
    assert.equal(tmux.resolveUserShell(), expected);
  } finally {
    if (original === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = original;
    }
  }
});

test("bash launcher starts a real login shell and preserves profile hooks", () => {
  const layout = tempLayout();
  try {
    writeGeneratedFiles(layout);
    fs.writeFileSync(layout.env, [
      "_persisterm_refresh() { export PERSISTERM_REFRESHED=1; }",
      "_persisterm_refresh",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(layout.home, ".bash_profile"), [
      "export STARTUP_ORDER=profile",
      "PROMPT_COMMAND=\"${PROMPT_COMMAND:+$PROMPT_COMMAND;}:\"",
      ". ~/.bashrc",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(layout.home, ".bashrc"),
      "export STARTUP_ORDER=\"$STARTUP_ORDER:rc\"\n");

    const result = spawnSync("script", [
      "-qec", `${layout.launcher} /bin/bash`, "/dev/null",
    ], {
      encoding: "utf8",
      input: "printf '%s|%s|' \"$STARTUP_ORDER\" \"$PERSISTERM_REFRESHED\"; shopt -q login_shell && echo login\nexit\n",
      env: { ...process.env, HOME: layout.home },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /profile:rc\|1\|login/);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("fish init runs after the user's config and installs its prompt hook", {
  skip: !fishPath,
}, () => {
  const layout = tempLayout();
  try {
    writeGeneratedFiles(layout);
    const fishConfig = path.join(layout.home, ".config", "fish");
    fs.mkdirSync(fishConfig, { recursive: true });
    fs.writeFileSync(path.join(fishConfig, "config.fish"),
      "set -gx STARTUP_ORDER config\n");

    const syntax = spawnSync(fishPath, ["-n", layout.fishInit], {
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, syntax.stderr);

    const result = spawnSync(fishPath, [
      "-C", `source '${layout.fishInit}'`, "-c",
      "functions -q _persisterm_refresh; and echo \"$STARTUP_ORDER|hook\"",
    ], {
      encoding: "utf8",
      env: { ...process.env, HOME: layout.home },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /config\|hook/);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("tmux starts zsh as the pane process through the generated launcher", {
  skip: !fs.existsSync("/usr/bin/zsh") || spawnSync("tmux", ["-V"]).status !== 0,
}, () => {
  const layout = tempLayout();
  const socket = `persisterm-test-${process.pid}-${Date.now()}`;
  const session = "shell-test";
  try {
    writeGeneratedFiles(layout);
    fs.writeFileSync(layout.env,
      "_persisterm_refresh() { export PERSISTERM_REFRESHED=1; }\n_persisterm_refresh\n");
    for (const [file, label] of [
      [".zshenv", "env"],
      [".zprofile", "profile"],
      [".zshrc", "rc"],
      [".zlogin", "login"],
    ]) {
      const printMarker = file === ".zlogin"
        ? "print -r -- PERSISTERM_STARTUP=$STARTUP_ORDER\n"
        : "";
      fs.writeFileSync(path.join(layout.home, file),
        `export STARTUP_ORDER=\"\${STARTUP_ORDER:+$STARTUP_ORDER:}${label}\"\n${printMarker}`);
    }
    const config = path.join(layout.config, "tmux.conf");
    fs.writeFileSync(config, tmux.buildTmuxConfig("/usr/bin/zsh", layout.launcher));

    const started = spawnSync("tmux", [
      "-f", config, "-L", socket, "new-session", "-d", "-s", session,
    ], {
      encoding: "utf8",
      env: { ...process.env, HOME: layout.home },
    });
    assert.equal(started.status, 0, started.stderr);

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    const pane = spawnSync("tmux", [
      "-L", socket, "display-message", "-p", "-t", session,
      "#{pane_current_command}",
    ], { encoding: "utf8" });
    assert.equal(pane.status, 0, pane.stderr);
    assert.equal(pane.stdout.trim(), "zsh");

    // Detached tmux panes can defer their initial redraw until the first input.
    spawnSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    const captured = spawnSync("tmux", [
      "-L", socket, "capture-pane", "-p", "-S", "-", "-t", session,
    ], { encoding: "utf8" });
    assert.equal(captured.status, 0, captured.stderr);
    assert.match(captured.stdout, /PERSISTERM_STARTUP=env:profile:rc:login/);
    assert.doesNotMatch(captured.stdout, /PERSISTERM_STARTUP=env:env/);
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test("zsh shim loads all native login files and restores user ZDOTDIR", {
  skip: !fs.existsSync("/usr/bin/zsh"),
}, () => {
  const layout = tempLayout();
  try {
    writeGeneratedFiles(layout);
    fs.writeFileSync(layout.env, [
      "_persisterm_refresh() { export PERSISTERM_REFRESHED=1; }",
      "_persisterm_refresh",
      "",
    ].join("\n"));

    for (const [file, label] of [
      [".zshenv", "env"],
      [".zprofile", "profile"],
      [".zshrc", "rc"],
      [".zlogin", "login"],
    ]) {
      fs.writeFileSync(path.join(layout.home, file),
        `export STARTUP_ORDER=\"\${STARTUP_ORDER:+$STARTUP_ORDER:}${label}\"\n`);
    }

    const result = spawnSync("/usr/bin/zsh", [
      "-lic",
      "printf '%s|%s|%s|%s\\n' \"$STARTUP_ORDER\" \"$PERSISTERM_REFRESHED\" \"$ZDOTDIR\" \"${precmd_functions[*]}\"",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: layout.home,
        PERSISTERM_USER_ZDOTDIR: layout.home,
        PERSISTERM_USER_ZDOTDIR_SET: "0",
        ZDOTDIR: layout.zsh,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /env:profile:rc:login\|1\|\|.*_persisterm_refresh/);
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});
