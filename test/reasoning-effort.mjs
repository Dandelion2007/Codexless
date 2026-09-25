import assert from "node:assert/strict";
import path from "node:path";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import { boundedAuthorityBindingFromStarted } from "../src/codex-authority-executor.mjs";

class FakeClient {
  constructor() {
    this.running = false;
    this.initializedResult = null;
    this.serverRequestMethods = [];
    this.requests = [];
    this.threadSeq = 0;
    this.turnSeq = 0;
    this.currentTurnId = null;
    this.threadModel = "fake-default";
    this.threadEffort = "medium";
  }

  async start() {
    this.running = true;
    this.initializedResult = { ok: true };
    return this.initializedResult;
  }

  onNotification() { return () => {}; }

  async close() { this.running = false; }

  async request(method, params = {}) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "model/list") {
      return {
        data: [
          {
            id: "fake-default",
            model: "fake-default",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "balanced" },
              { reasoningEffort: "high", description: "fixture downgrade check" },
              { reasoningEffort: "ultra", description: "deep" },
            ],
          },
          {
            id: "fake-fast",
            model: "fake-fast",
            isDefault: false,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      this.threadSeq += 1;
      this.threadModel = params.model ?? "fake-default";
      const requestedEffort = params.config?.model_reasoning_effort ?? null;
      this.threadEffort = requestedEffort === "high" ? "medium" : requestedEffort ?? "medium";
      return {
        thread: { id: `thread-${this.threadSeq}`, canAcceptDirectInput: true },
        activePermissionProfile: { id: params.permissions ?? ":read-only" },
        sandbox: { type: "readOnly", networkAccess: false },
        model: this.threadModel,
        modelProvider: "openai",
        serviceTier: null,
        reasoningEffort: this.threadEffort,
      };
    }
    if (method === "turn/start") {
      this.turnSeq += 1;
      this.currentTurnId = `turn-${this.turnSeq}`;
      return { turn: { id: this.currentTurnId, status: "inProgress", items: [] } };
    }
    if (method === "thread/turns/list") {
      return {
        data: this.currentTurnId
          ? [{ id: this.currentTurnId, status: "completed", items: [{ type: "agentMessage", text: "DONE" }] }]
          : [],
      };
    }
    if (method === "thread/resume") {
      return {
        thread: { id: `thread-${this.threadSeq}`, canAcceptDirectInput: true },
        model: this.threadModel,
        modelProvider: "openai",
        serviceTier: null,
        reasoningEffort: this.threadEffort,
      };
    }
    throw new Error(`unexpected fake request: ${method}`);
  }
}

const fake = new FakeClient();
assert.throws(
  () => boundedAuthorityBindingFromStarted({
    sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [path.resolve(".")] },
  }, ":workspace"),
  /v1 supports only the complete :read-only authority identity/
);
assert.throws(
  () => boundedAuthorityBindingFromStarted({
    sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [path.resolve(".")] },
  }, ":read-only"),
  /unsupported sandbox projection/
);
const executor = new CodexAgentExecutor({
  defaultCwd: path.resolve("."),
  clientFactory: () => fake,
});
await executor.open();

const unsupportedThreadStartsBefore = fake.requests.filter((entry) => entry.method === "thread/start").length;
await assert.rejects(
  () => executor.start({
    task: "unsupported effort",
    clientRequestId: "effort-invalid-1",
    model: "fake-fast",
    reasoningEffort: "ultra",
  }),
  /supported efforts: low/
);
assert.equal(
  fake.requests.filter((entry) => entry.method === "thread/start").length,
  unsupportedThreadStartsBefore,
  "unsupported model/effort pairs must fail before thread dispatch"
);

const turnsBeforeDowngrade = fake.requests.filter((entry) => entry.method === "turn/start").length;
await assert.rejects(
  () => executor.start({
    task: "must fail before turn",
    clientRequestId: "effort-downgrade-1",
    model: "fake-default",
    reasoningEffort: "high",
  }),
  /CODEX_AGENT_SELECTION_MISMATCH.*prepared reasoning effort "high".*observed medium.*no Codex turn was started/
);
assert.equal(
  fake.requests.filter((entry) => entry.method === "turn/start").length,
  turnsBeforeDowngrade,
  "an App Server reasoning downgrade must fail closed before any model turn"
);

const started = await executor.start({
  task: "explicit effort",
  clientRequestId: "effort-start-1",
  reasoningEffort: "ultra",
});
assert.equal(started.execution.requestedModel, null);
assert.equal(started.execution.resolvedModel, "fake-default");
assert.equal(started.execution.requestedReasoningEffort, "ultra");
assert.equal(started.execution.reasoningEffort, "ultra");
const threadStart = fake.requests.filter((entry) => entry.method === "thread/start").at(-1);
const firstTurn = fake.requests.filter((entry) => entry.method === "turn/start").at(-1);
assert.equal(threadStart.params.model, "fake-default", "omitted model should resolve the current default only when effort validation requires it");
assert.equal(threadStart.params.reasoningEffort, undefined, "thread/start must not use the unsupported top-level reasoningEffort field");
assert.equal(threadStart.params.config?.model_reasoning_effort, "ultra");
assert.equal(firstTurn.params.effort, "ultra", "explicit start effort must also bind the first turn");

const duplicate = await executor.start({
  task: "explicit effort",
  clientRequestId: "effort-start-1",
  reasoningEffort: "ultra",
});

const turnsBeforeAuthorityMismatch = fake.requests.filter((entry) => entry.method === "turn/start").length;
await assert.rejects(
  () => executor.start({
    task: "authority mismatch", clientRequestId: "authority-mismatch-1", permissionProfile: ":read-only",
    expectedAuthorityBinding: { permissionProfile: ":read-only", sandboxType: "readOnly", networkAccess: true },
  }),
  /authority binding mismatch/
);
assert.equal(fake.requests.filter((entry) => entry.method === "turn/start").length, turnsBeforeAuthorityMismatch);
assert.equal(duplicate.duplicate, true);
await assert.rejects(
  () => executor.start({
    task: "explicit effort",
    clientRequestId: "effort-start-1",
    reasoningEffort: "medium",
  }),
  /different agent start/
);

await executor.show({ agentRef: started.agentRef });
const sent = await executor.send({
  agentRef: started.agentRef,
  message: "follow-up effort",
  clientRequestId: "effort-send-1",
  reasoningEffort: "medium",
});
assert.equal(sent.execution.requestedReasoningEffort, "medium");
const followupTurn = fake.requests.filter((entry) => entry.method === "turn/start").at(-1);
assert.equal(followupTurn.params.effort, "medium");
const sendDuplicate = await executor.send({
  agentRef: started.agentRef,
  message: "follow-up effort",
  clientRequestId: "effort-send-1",
  reasoningEffort: "medium",
});
assert.equal(sendDuplicate.duplicate, true);
await assert.rejects(
  () => executor.send({
    agentRef: started.agentRef,
    message: "follow-up effort",
    clientRequestId: "effort-send-1",
    reasoningEffort: "ultra",
  }),
  /different agent send/
);

await executor.close();
console.log("reasoning effort dynamic validation + dispatch PASS");
