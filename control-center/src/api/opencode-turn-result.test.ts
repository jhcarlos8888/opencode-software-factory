import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOpenCodeTurnResult } from "./opencode-turn-result.js";
import { classifyOpenCodeServerLog } from "./opencode-log-classifier.js";
import { extractCanonicalOpenCodeAssistantText, prepareHandoffOutput } from "./orchestration.js";

const handoff = "HANDOFF-BUILD-251ECFC7\n\nAnálisis de construcción verificado.";
const finalMessage = {
  info: { id: "final", role: "assistant", finish: "stop" },
  parts: [{ type: "text", text: handoff }]
};

test("models.dev timeout while a session finishes preserves a valid handoff", () => {
  const log = 'level=ERROR message="Failed to fetch models.dev" cause="TimeoutError: Operation timed out after 10s"';
  const diagnostic = classifyOpenCodeServerLog(log, false);
  assert.equal(diagnostic.kind, "warning");
  assert.equal(diagnostic.failure, false);
  const messages = { data: [finalMessage] };
  const final = extractCanonicalOpenCodeAssistantText(messages);
  assert.equal(final, handoff);
  assert.doesNotThrow(() => validateOpenCodeTurnResult(final!, messages));
  const envelope = prepareHandoffOutput(final!, "HANDOFF-BUILD-251ECFC7");
  assert.equal(envelope.sourceIdentityVerified, true);
  assert.equal(envelope.truncated, false);
});

test("actual failed provider response is rejected even with a previous good handoff", () => {
  const messages = { data: [
    finalMessage,
    { info: { role: "assistant", finish: "error", error: { name: "AI.Error.Authentication", message: "denied" } }, parts: [] }
  ] };
  assert.throws(() => validateOpenCodeTurnResult(handoff, messages), /error de proveedor/i);
});

test("empty turn and explicit rejection still fail", () => {
  assert.throws(() => validateOpenCodeTurnResult("", { data: [] }), /sin producir una respuesta/);
  assert.throws(() => validateOpenCodeTurnResult("AI.Error.Authentication", { data: [finalMessage] }), /rechazó la solicitud/);
});

test("native terminal denial plus persisted rejection is explained without replay or success", () => {
  const terminal = {info:{role:"assistant",finish:"error",error:{type:"aborted",message:"Step interrupted"}},parts:[
    {type:"tool",state:{status:"error",error:{type:"aborted",message:"The user declined this tool call"}}}
  ]};
  assert.throws(() => validateOpenCodeTurnResult("",{data:[terminal]},{rejectedPermission:true}), /rechazarse una operación.*no se repetirá automáticamente/);
  assert.throws(() => validateOpenCodeTurnResult("",{data:[terminal]},{rejectedPermission:false}), /error de proveedor/);
  assert.throws(() => validateOpenCodeTurnResult(handoff,{data:[finalMessage,terminal]},{rejectedPermission:true}), /ni se publicará un handoff incompleto/);
  assert.doesNotThrow(() => validateOpenCodeTurnResult(handoff,{data:[terminal,finalMessage]},{rejectedPermission:true}));
  assert.throws(() => validateOpenCodeTurnResult("",{data:[]},{rejectedPermission:true}), /después de una operación rechazada/);
  assert.throws(() => validateOpenCodeTurnResult("",{data:[{info:{role:"assistant",finish:"error",error:{type:"rate_limit",message:"429"}}}]},{rejectedPermission:true}), /error de proveedor/);
});
