const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isSessionForPrefix,
  workspaceSessionPrefix,
} = require("../out/session-names");

test("folderless windows keep the legacy global prefix", () => {
  assert.equal(workspaceSessionPrefix("persisterm"), "persisterm");
});

test("workspace folders get stable, distinct prefixes", () => {
  const first = workspaceSessionPrefix(
    "persisterm",
    "vscode-remote://ssh-remote+host/home/user/project-a",
  );
  const repeated = workspaceSessionPrefix(
    "persisterm",
    "vscode-remote://ssh-remote+host/home/user/project-a",
  );
  const second = workspaceSessionPrefix(
    "persisterm",
    "vscode-remote://ssh-remote+host/home/user/project-b",
  );

  assert.match(first, /^persisterm-ws-[0-9a-f]{10}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, second);
});

test("session matching does not mix global and workspace prefixes", () => {
  assert.equal(isSessionForPrefix("persisterm-0", "persisterm"), true);
  assert.equal(
    isSessionForPrefix("persisterm-ws-0123456789-0", "persisterm"),
    false,
  );
  assert.equal(
    isSessionForPrefix(
      "persisterm-ws-0123456789-0",
      "persisterm-ws-0123456789",
    ),
    true,
  );
  assert.equal(isSessionForPrefix("custom.prefix-12", "custom.prefix"), true);
});
