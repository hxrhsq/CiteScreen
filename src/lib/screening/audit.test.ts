import assert from "node:assert/strict";
import { test } from "node:test";
import { latestDecision, toAuditCsv, toAuditJson } from "./audit";
import type { AuditEvent } from "./types";

const event: AuditEvent = {
  id: "evt-1",
  at: "2026-11-02T18:00:00.000Z",
  jobTitle: "Senior Backend Engineer",
  candidateId: "helen-cho",
  candidateName: "Helen Cho",
  mode: "mock",
  model: "deterministic-mock",
  systemRecommendation: "decline",
  systemScore: 22,
  decision: "hold",
  override: true,
  note: 'Portfolio review, said "not yet"',
  blindScore: 14,
  blindDelta: -8,
  fairnessFlag: true,
};

test("csv escapes commas and quotes and keeps the override column", () => {
  const csv = toAuditCsv([event]);
  const [header, row] = csv.split("\n");
  assert.match(header ?? "", /^id,at,jobTitle,/);
  assert.match(header ?? "", /override/);
  assert.match(row ?? "", /"Portfolio review, said ""not yet"""/);
  assert.match(row ?? "", /,true,/);
  assert.match(row ?? "", /,hold,/);
});

test("json export round-trips the decision trail", () => {
  const raw = toAuditJson({
    exportedAt: "2026-11-02T18:05:00.000Z",
    jobTitle: "Senior Backend Engineer",
    mode: "mock",
    model: "deterministic-mock",
    events: [event],
  });
  const parsed = JSON.parse(raw) as { product: string; events: AuditEvent[] };
  assert.equal(parsed.product, "CiteScreen");
  assert.equal(parsed.events[0]?.override, true);
  assert.equal(parsed.events[0]?.decision, "hold");
  assert.equal(parsed.events[0]?.fairnessFlag, true);
});

test("latest decision is the last event for that candidate", () => {
  const second: AuditEvent = { ...event, id: "evt-2", decision: "decline", override: false, note: "" };
  assert.equal(latestDecision([event, second], "helen-cho")?.id, "evt-2");
  assert.equal(latestDecision([event], "missing"), undefined);
});
