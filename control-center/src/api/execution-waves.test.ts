import assert from "node:assert/strict";
import test from "node:test";
import { EXECUTION_WAVES } from "./execution-waves.js";

test("discovery runs Architect and Build together across engines", () => {
  assert.deepEqual(EXECUTION_WAVES[0]?.agentIds, ["architect", "build"]);
});

test("Reverse starts only after both discovery handoffs exist", () => {
  const index = (agent: string) => EXECUTION_WAVES.findIndex((wave) =>
    (wave.agentIds as readonly string[]).includes(agent));
  assert.ok(index("reverse") > index("architect"));
  assert.ok(index("reverse") > index("build"));
});

test("Tester finishes before Reviewer starts so Reviewer receives its real result", () => {
  const index = (agent: string) => EXECUTION_WAVES.findIndex((wave) =>
    (wave.agentIds as readonly string[]).includes(agent));
  assert.ok(index("tester") > index("implementer"));
  assert.ok(index("reviewer") > index("tester"));
  assert.ok(index("cloud-arbiter") > index("reviewer"));
});

test("each agent appears exactly once in the execution plan", () => {
  const agents = EXECUTION_WAVES.flatMap((wave) => wave.agentIds);
  assert.equal(new Set(agents).size, agents.length);
  assert.deepEqual([...agents].sort(), [
    "architect", "build", "cloud-arbiter", "implementer", "reverse", "reviewer", "tester"
  ]);
});
