import assert from "node:assert/strict";
import { createPublicToolRegistrationGate } from "../src/public-server-factory.mjs";
import { PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

function fakeServer() {
  const tools = [];
  const resources = [];
  return {
    tools,
    resources,
    registerTool(name, config, handler) { tools.push({ name, config, handler }); return name; },
    registerResource(...args) { resources.push(args); return args[0]; },
  };
}

{
  const raw = fakeServer();
  const gate = createPublicToolRegistrationGate(raw);
  for (const name of PUBLIC_TOOL_NAMES) gate.server.registerTool(name, {}, () => null);
  assert.deepEqual(gate.assertComplete(), {
    expectedCount: PUBLIC_TOOL_NAMES.length,
    registeredCount: PUBLIC_TOOL_NAMES.length,
    skippedToolNames: [],
  }, "the canonical 45-tool public allowlist must register exactly once");
}

{
  const raw = fakeServer();
  const gate = createPublicToolRegistrationGate(raw, { allowedToolNames: ["codex.allowed"] });
  assert.equal(gate.server.registerTool("codex.allowed", {}, () => null), "codex.allowed");
  assert.equal(gate.server.registerTool("codex.private_future", {}, () => null), undefined, "unknown private growth must be skipped at runtime");
  assert.equal(gate.server.registerResource("card", "ui://card", {}, () => null), "card", "non-tool server methods must pass through the proxy");
  assert.deepEqual(raw.tools.map((row) => row.name), ["codex.allowed"]);
  assert.equal(raw.resources.length, 1);
  assert.deepEqual(gate.assertComplete(), { expectedCount: 1, registeredCount: 1, skippedToolNames: ["codex.private_future"] });
}

{
  const raw = fakeServer();
  const gate = createPublicToolRegistrationGate(raw, { allowedToolNames: ["codex.required"] });
  gate.server.registerTool("codex.private_future", {}, () => null);
  assert.throws(() => gate.assertComplete(), /PUBLIC_TOOL_REGISTRATION_INCOMPLETE:codex.required/);
  assert.equal(raw.tools.length, 0, "an unknown tool must never reach the real MCP server");
}
{
  const raw = fakeServer();
  const gate = createPublicToolRegistrationGate(raw, { allowedToolNames: ["codex.required"] });
  gate.server.registerTool("codex.renamed", {}, () => null);
  assert.throws(() => gate.assertComplete(), /PUBLIC_TOOL_REGISTRATION_INCOMPLETE:codex.required/, "renaming a registered tool must leave its canonical name missing");
  assert.equal(raw.tools.length, 0, "a renamed tool must never reach the real MCP server");
}

{
  const raw = fakeServer();
  const gate = createPublicToolRegistrationGate(raw, { allowedToolNames: ["codex.required"] });
  gate.server.registerTool("codex.required", {}, () => null);
  assert.throws(() => gate.server.registerTool("codex.required", {}, () => null), /PUBLIC_TOOL_REGISTRATION_DUPLICATE:codex.required/);
}

{
  const raw = fakeServer();
  const gate = createPublicToolRegistrationGate(raw, { allowedToolNames: ["codex.required"], strictUnknown: true });
  assert.throws(() => gate.server.registerTool("codex.private_future", {}, () => null), /PUBLIC_TOOL_REGISTRATION_FORBIDDEN:codex.private_future/);
  assert.equal(raw.tools.length, 0);
}

assert.throws(
  () => createPublicToolRegistrationGate(fakeServer(), { allowedToolNames: ["codex.same", "codex.same"] }),
  /PUBLIC_TOOL_ALLOWLIST_DUPLICATE/
);

console.log("Public runtime tool-registration allowlist PASS");
