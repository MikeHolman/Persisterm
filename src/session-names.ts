import { createHash } from "crypto";

/**
 * Scope a tmux session prefix to a workspace folder.
 *
 * Folderless windows intentionally keep the base prefix so they continue to
 * see legacy global sessions such as `persisterm-0`.
 */
export function workspaceSessionPrefix(
  basePrefix: string,
  workspaceFolderUri?: string,
): string {
  if (!workspaceFolderUri) {
    return basePrefix;
  }

  const folderHash = createHash("sha256")
    .update(workspaceFolderUri)
    .digest("hex")
    .slice(0, 10);
  return `${basePrefix}-ws-${folderHash}`;
}

/** Return whether a session has the exact indexed form `<prefix>-N`. */
export function isSessionForPrefix(name: string, prefix: string): boolean {
  return new RegExp(`^${escapeRegex(prefix)}-\\d+$`).test(name);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
