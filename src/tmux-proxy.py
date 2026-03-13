#!/usr/bin/env python3
"""
tmux-proxy — Bridge between VS Code's terminal and tmux control mode.

VS Code runs this script in its terminal (providing a pty on our
stdin/stdout).  We create a second pty for tmux's control mode and
bridge the two, translating between the control protocol and raw
terminal I/O.

Usage:
    tmux-proxy.py <session-name> [--socket <name>] [--config <path>] [--reattach]
"""

import os
import pty
import sys
import select
import signal
import subprocess
import time
import re
import argparse

# ── CLI ─────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="tmux control mode proxy")
parser.add_argument("session", help="tmux session name")
parser.add_argument("--socket", default="persisterm", help="tmux socket name")
parser.add_argument("--config", default="", help="tmux config file path")
parser.add_argument("--reattach", action="store_true", help="replay scrollback history first")
args = parser.parse_args()

# ── Helpers ─────────────────────────────────────────────────────────

def tmux_base_cmd():
    cmd = ["tmux"]
    if args.config:
        cmd += ["-f", args.config]
    cmd += ["-L", args.socket]
    return cmd


def unescape_output(data):
    """
    Unescape tmux control-mode %output data.
    tmux escapes non-printable bytes as octal \\NNN and backslash as \\\\.
    Returns raw bytes suitable for writing to stdout.
    """
    result = bytearray()
    i = 0
    while i < len(data):
        if data[i] == '\\' and i + 1 < len(data):
            if data[i + 1] == '\\':
                result.append(0x5C)  # literal backslash
                i += 2
            elif (i + 3 < len(data) and
                  data[i+1] in '01234567' and
                  data[i+2] in '01234567' and
                  data[i+3] in '01234567'):
                val = int(data[i+1:i+4], 8)
                result.append(val & 0xFF)
                i += 4
            else:
                # Unknown escape — encode the backslash as UTF-8
                result.extend(data[i].encode("utf-8"))
                i += 1
        else:
            # Encode each character as UTF-8 (handles non-ASCII safely)
            result.extend(data[i].encode("utf-8"))
            i += 1
    return bytes(result)


def bytes_to_hex(data):
    """Convert bytes to space-separated hex for send-keys -H."""
    return " ".join(f"{b:02x}" for b in data)


# ── Replay history on reconnect ────────────────────────────────────

def replay_history():
    """Replay session history into VS Code's terminal before reconnecting.

    Returns True if the pane is in alternate screen mode (fullscreen app).
    """
    try:
        # Check if the pane is in alternate screen mode (full-screen apps
        # like vim, htop, copilot CLI).
        alt_cmd = tmux_base_cmd() + [
            "display-message", "-p", "-t", args.session,
            "#{alternate_on} #{pane_height}"
        ]
        alt_result = subprocess.run(alt_cmd, capture_output=True, text=True, timeout=5)
        alternate_on = False
        pane_height = 24
        if alt_result.returncode == 0:
            parts = alt_result.stdout.strip().split()
            if len(parts) >= 2:
                alternate_on = parts[0] == "1"
                try:
                    pane_height = int(parts[1])
                except ValueError:
                    pass

        if alternate_on:
            # Full scrollback (history + visible) without -a.  The last
            # pane_height lines are the fullscreen app's visible content;
            # everything before is the shell scrollback history.
            full_cmd = tmux_base_cmd() + [
                "capture-pane", "-e", "-p", "-t", args.session, "-S", "-"
            ]
            full = subprocess.run(full_cmd, capture_output=True, text=True, timeout=5)
            if full.returncode == 0 and full.stdout:
                lines = full.stdout.split("\n")
                if len(lines) > pane_height:
                    history_lines = lines[:-(pane_height)]
                    history = "\r\n".join(l for l in history_lines)
                    if history.strip():
                        # Write shell history into VS Code's main buffer.
                        sys.stdout.buffer.write(history.encode("utf-8", errors="replace"))
                        sys.stdout.buffer.write(b"\x1b[0m\r\n")
                        # Push the history into scrollback by filling the
                        # visible area with blank lines, then clearing.
                        # This forces the terminal to scroll the history
                        # text up into the scrollback buffer.
                        sys.stdout.buffer.write(b"\r\n" * pane_height)
                        sys.stdout.buffer.write(b"\x1b[H\x1b[J")  # home + clear visible
                        sys.stdout.buffer.flush()

            # Now enter alt screen and draw the fullscreen app's content.
            vis_cmd = tmux_base_cmd() + [
                "capture-pane", "-e", "-p", "-t", args.session
            ]
            vis = subprocess.run(vis_cmd, capture_output=True, text=True, timeout=5)
            sys.stdout.buffer.write(b"\x1b[?1049h")  # enter alt screen
            sys.stdout.buffer.write(b"\x1b[H\x1b[J")  # home + clear
            if vis.returncode == 0 and vis.stdout:
                text = vis.stdout.replace("\n", "\r\n")
                sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
            sys.stdout.buffer.write(b"\x1b[0m")
            sys.stdout.buffer.flush()
            return True
        else:
            # Normal shell — replay full scrollback history.
            cmd = tmux_base_cmd() + [
                "capture-pane", "-e", "-p", "-t", args.session, "-S", "-"
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if result.returncode == 0 and result.stdout:
                text = result.stdout.replace("\n", "\r\n")
                sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
                sys.stdout.buffer.write(b"\x1b[0m")

            sys.stdout.buffer.flush()
            return False
    except Exception:
        return False


# ── Terminal size ───────────────────────────────────────────────────

def get_terminal_size():
    try:
        cols, rows = os.get_terminal_size(sys.stdout.fileno())
        return cols, rows
    except Exception:
        return 80, 24


# ── Main proxy ──────────────────────────────────────────────────────

def main():
    in_alt_screen = False
    if args.reattach:
        in_alt_screen = replay_history()

    # Create a pty pair for tmux control mode.
    master_fd, slave_fd = pty.openpty()

    # Spawn tmux in control mode (-CC = no command echo).
    tmux_cmd = tmux_base_cmd() + ["-CC", "new-session", "-A", "-s", args.session]
    proc = subprocess.Popen(
        tmux_cmd,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=subprocess.PIPE,
    )
    os.close(slave_fd)  # parent only uses master

    pane_id = "%0"
    exiting = False
    line_buf = ""

    # Send initial terminal size to tmux.
    cols, rows = get_terminal_size()
    os.write(master_fd, f"refresh-client -C {cols}x{rows}\n".encode())

    # Handle SIGWINCH (terminal resize).
    def on_resize(signum, frame):
        nonlocal cols, rows
        cols, rows = get_terminal_size()
        try:
            os.write(master_fd, f"refresh-client -C {cols}x{rows}\n".encode())
        except Exception:
            pass

    signal.signal(signal.SIGWINCH, on_resize)

    # Don't exit on SIGINT — forward it to tmux as Ctrl+C.
    def on_sigint(signum, frame):
        try:
            os.write(master_fd, f"send-keys -H -t {pane_id} 03\n".encode())
        except Exception:
            pass

    signal.signal(signal.SIGINT, on_sigint)

    # Forward SIGTSTP (Ctrl+Z) to tmux as well.
    def on_sigtstp(signum, frame):
        try:
            os.write(master_fd, f"send-keys -H -t {pane_id} 1a\n".encode())  # 0x1A = SUB (Ctrl+Z)
        except Exception:
            pass

    signal.signal(signal.SIGTSTP, on_sigtstp)

    # Put our stdin in raw mode so we get individual bytes.
    old_settings = None
    if os.isatty(sys.stdin.fileno()):
        import tty
        import termios
        old_settings = termios.tcgetattr(sys.stdin.fileno())
        tty.setraw(sys.stdin.fileno())

    def cleanup():
        nonlocal old_settings
        if old_settings is not None:
            import termios
            try:
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old_settings)
            except Exception:
                pass
            old_settings = None
        try:
            os.close(master_fd)
        except Exception:
            pass

    def process_control_line(line):
        """Parse a single line of tmux control mode output."""
        nonlocal pane_id, exiting

        if line.startswith("%output "):
            # %output %<pane-id> <escaped-data>
            rest = line[8:]  # after "%output "
            space = rest.find(" ")
            if space > 0:
                pane_id = rest[:space]
                escaped = rest[space + 1:]
                raw = unescape_output(escaped)
                sys.stdout.buffer.write(raw)
                sys.stdout.buffer.flush()

        elif line.startswith("%extended-output "):
            # %extended-output %<pane-id> <age> ... : <escaped-data>
            # New format in tmux 3.4+ with pause-after.
            colon_idx = line.find(" : ")
            if colon_idx > 0:
                # Extract pane-id from after "%extended-output "
                parts = line[17:colon_idx].split()
                if parts:
                    pane_id = parts[0]
                escaped = line[colon_idx + 3:]
                raw = unescape_output(escaped)
                sys.stdout.buffer.write(raw)
                sys.stdout.buffer.flush()

        elif line.startswith("%exit"):
            exiting = True

    try:
        stdin_fd = sys.stdin.fileno()

        # Input batching: accumulate bytes and flush every ~2ms
        input_buf = bytearray()
        last_input_time = 0.0

        while not exiting:
            # Compute timeout: if we have buffered input, use a short timeout
            timeout = 0.002 if input_buf else 0.1

            try:
                readable, _, _ = select.select([master_fd, stdin_fd], [], [], timeout)
            except (select.error, ValueError, OSError):
                break

            # Flush buffered input if timeout elapsed
            now = time.monotonic()
            if input_buf and (not readable or now - last_input_time > 0.002):
                hex_str = bytes_to_hex(input_buf)
                cmd = f"send-keys -H -t {pane_id} {hex_str}\n"
                try:
                    os.write(master_fd, cmd.encode())
                except Exception:
                    break
                input_buf.clear()

            if master_fd in readable:
                try:
                    data = os.read(master_fd, 65536)
                except OSError:
                    break
                if not data:
                    break

                # Parse control mode output line by line.
                text = data.decode("utf-8", errors="replace")
                line_buf += text
                lines = line_buf.split("\n")
                line_buf = lines.pop()  # keep incomplete last line

                for line in lines:
                    line = line.rstrip("\r")
                    # tmux wraps the initial output in DCS (ESC P 1000p).
                    # Strip that wrapper — it only appears at the start.
                    if line.startswith("\x1bP1000p"):
                        line = line[7:]
                    # ST (String Terminator \x1b\\) can end the DCS block.
                    if line == "\x1b\\":
                        continue
                    if line:
                        process_control_line(line)

            if stdin_fd in readable:
                try:
                    data = os.read(stdin_fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                input_buf.extend(data)
                last_input_time = time.monotonic()

    except Exception as e:
        import traceback
        err_msg = traceback.format_exc()
        sys.stderr.write(f"tmux-proxy error: {err_msg}\n")
        # Also write to stdout so the error is visible in the terminal
        sys.stdout.buffer.write(f"\r\n\x1b[31mtmux-proxy error: {e}\x1b[0m\r\n".encode())
        sys.stdout.buffer.flush()
        # Log to file for debugging
        try:
            log_path = os.path.join(os.path.expanduser("~"), ".config", "persisterm", "proxy-error.log")
            with open(log_path, "a") as f:
                f.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n{err_msg}\n")
        except Exception:
            pass
    finally:
        cleanup()
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            pass


if __name__ == "__main__":
    main()
