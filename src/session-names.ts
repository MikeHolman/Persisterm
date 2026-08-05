import { createHash } from "crypto";

/**
 * Scope a tmux session prefix to a workspace folder.
 *
 * Folderless windows intentionally keep the base prefix so they continue to
 * see legacy global sessions such as `persisterm-0`. An explicitly configured
 * prefix is also kept unchanged for compatibility with manual isolation.
 */
export function workspaceSessionPrefix(
  basePrefix: string,
  workspaceFolderUri?: string,
  explicitlyConfigured = false,
): string {
  if (!workspaceFolderUri || explicitlyConfigured) {
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
