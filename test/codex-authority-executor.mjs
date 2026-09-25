import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";

const COMPATIBILITY_PROBE_MARKER = "TOOLWIRE_CODEX_CONTRACT_OK";
const root = await mkdtemp(path.join(os.tmpdir(), "codexless-authority-"));

function started({ profile = ":read-only", sandbox = { type: "readOnly", networkAccess: false } } = {}) {
  return {
    cwd: root,
    activePermissionProfile: { id: profile },
    runtimeWorkspaceRoots: [root],
    sandbox,
  };
}

function makeExecutor({
  profileOverride = ":read-only",
  boundedStarted = started(),
  afterThreadStart = null,
  allowedProfiles = [{ id: ":read-only", allowed: true }, { id: ":workspace", allowed: true }],
} = {}) {
  const clients = [];
  const config = { projects: { [root]: { trust_level: "trusted" } } };
  const clientFactory = () => {
    const client = {
      notificationMethods: [],
      serverRequestMethods: [],
      requests: [],
      async start() {},
      async close() {},
      async request(method, params) {
        this.requests.push({ method, params });
        if (method === "config/read") return { config };
        if (method === "permissionProfile/list") {
          return { data: allowedProfiles };
        }
        if (method === "thread/start") {
          afterThreadStart?.(this);
          return boundedStarted;
        }
        throw new Error(`unexpected method: ${method}`);
      },
      async exec() {
        return { exitCode: 0, stdout: COMPATIBILITY_PROBE_MARKER, stderr: "" };
      },
    };
    clients.push(client);
    return client;
  };
  return {
    clients,
    executor: new CodexAuthorityExecutor({
      codexBin: "fake-codex",
      defaultCwd: root,
      profileOverride,
      clientFactory,
      versionProbe: async () => "codex-cli 0.0.0-test",
    }),
  };
}

try {
  {
    const { executor, clients } = makeExecutor();
    await executor.validate();
    const resolved = await executor.resolveAuthority({ requireBoundedAuthorityBinding: true });
    assert.deepEqual(resolved.authorityBinding, {
      permissionProfile: ":read-only",
      sandboxType: "readOnly",
      networkAccess: false,
    });
    assert.equal(resolved.permissionProfile, ":read-only");
    assert.equal(resolved.authoritySource, "host-profile-override");
    const threadStart = clients.at(-1).requests.find(({ method }) => method === "thread/start");
    assert.deepEqual(threadStart.params.permissions, ":read-only");
    assert.equal(threadStart.params.ephemeral, true);
    assert.deepEqual(threadStart.params.config.features, { plugins: false, apps: false });
    assert.equal(clients.flatMap((client) => client.requests).some(({ method }) => method === "turn/start"), false);
  }

  for (const [label, boundedStarted, message] of [
    ["profile mismatch", started({ profile: ":workspace" }), /did not accept/],
    ["workspace sandbox", started({ sandbox: { type: "workspaceWrite", networkAccess: false } }), /unsupported sandbox projection/],
    ["missing network", started({ sandbox: { type: "readOnly" } }), /missing or invalid/],
    ["invalid network", started({ sandbox: { type: "readOnly", networkAccess: "false" } }), /missing or invalid/],
    ["extra sandbox authority", started({ sandbox: { type: "readOnly", networkAccess: false, writableRootCount: 0 } }), /unsupported sandbox projection/],
    ["runtime cwd drift", { ...started(), cwd: `${root}-other` }, /conflicts with thread\/start cwd/],
    ["runtime root drift", { ...started(), runtimeWorkspaceRoots: [`${root}-other`] }, /conflicts with thread\/start runtimeWorkspaceRoots/],
  ]) {
    const { executor, clients } = makeExecutor({ boundedStarted });
    await executor.validate();
    await assert.rejects(() => executor.resolveAuthority({ requireBoundedAuthorityBinding: true }), message, label);
    assert.equal(clients.flatMap((client) => client.requests).some(({ method }) => method === "turn/start"), false, label);
  }

  {
    const { executor, clients } = makeExecutor({
      afterThreadStart(client) { client.notificationMethods.push("turn/started"); },
    });
    await executor.validate();
    await assert.rejects(() => executor.resolveAuthority({ requireBoundedAuthorityBinding: true }), /model turn\/token-usage event/);
    assert.equal(clients.flatMap((client) => client.requests).some(({ method }) => method === "turn/start"), false);
  }

  {
    const { executor } = makeExecutor({
      boundedStarted: started({ sandbox: { type: "readOnly", networkAccess: true } }),
    });
    await executor.validate();
    const resolved = await executor.resolveAuthority({ requireBoundedAuthorityBinding: true });
    assert.equal(resolved.authorityBinding.networkAccess, true, "generic v1 binding must not impose strict no-network policy");
  }

  {
    const { executor, clients } = makeExecutor({ profileOverride: ":workspace" });
    await executor.validate();
    await assert.rejects(
      () => executor.resolveAuthority({ requireBoundedAuthorityBinding: true }),
      /not the complete :read-only v1 authority identity/
    );
    assert.equal(clients.flatMap((client) => client.requests).some(({ method }) => method === "thread/start"), false);
  }

  {
    const { executor, clients } = makeExecutor({ profileOverride: "custom-read-only" });
    await assert.rejects(
      () => executor.validate(),
      /host profile override is not allowed/
    );
    assert.equal(clients.flatMap((client) => client.requests).some(({ method }) => method === "thread/start"), false);
  }

  {
    const { executor, clients } = makeExecutor({
      allowedProfiles: [{ id: ":read-only", allowed: false }],
    });
    await assert.rejects(() => executor.validate(), /returned no allowed profiles/);
    assert.equal(clients.flatMap((client) => client.requests).some(({ method }) => method === "thread/start"), false);
  }

  {
    const { executor, clients } = makeExecutor({ profileOverride: ":workspace" });
    await executor.validate();
    const resolved = await executor.resolveAuthority({ requireBoundedAuthorityBinding: false });
    assert.equal(resolved.permissionProfile, ":workspace");
    assert.equal(resolved.authoritySource, "host-profile-override");
    assert.equal(Object.hasOwn(resolved, "authorityBinding"), false);
    assert.equal(clients.flatMap((client) => client.requests).some(({ method }) => method === "thread/start"), false);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("codex authority executor tests passed");
