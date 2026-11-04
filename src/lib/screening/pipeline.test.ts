import assert from "node:assert/strict";
import { test } from "node:test";
import { ScreeningError, resolveRunMode } from "../config";
import { heuristicExtract } from "./extract";
import { parseModelJson } from "./llm";
import { buildBlindReview, screenPacket } from "./pipeline";
import { loadJobs, loadResumes } from "./samples";

test("heuristic extraction keeps must-have years and preferred bullets", () => {
  const requirements = heuristicExtract(`Requirements
- 5+ years of Python
- Production Kubernetes

Preferred
- Kafka experience
`);
  assert.equal(requirements.length, 3);
  assert.equal(requirements[0]?.category, "must_have");
  assert.equal(requirements[0]?.minYears, 5);
  assert.equal(requirements[1]?.category, "must_have");
  assert.equal(requirements[2]?.category, "nice_to_have");
  assert.ok(requirements[2]?.keywords.includes("kafka"));
});

test("model JSON is accepted with a fence and a preamble", () => {
  const parsed = parseModelJson('Sure.\n```json\n{"requirements":[{"id":"req-1"}]}\n```');
  assert.deepEqual(parsed, { requirements: [{ id: "req-1" }] });
});

test("auto mode stays on the deterministic mock when no key is present", () => {
  const previousKey = process.env.VULTR_API_KEY;
  const previousAlt = process.env.VULTR_INFERENCE_API_KEY;
  const previousMode = process.env.SCREENING_MODE;
  delete process.env.VULTR_API_KEY;
  delete process.env.VULTR_INFERENCE_API_KEY;
  process.env.SCREENING_MODE = "auto";
  try {
    assert.equal(resolveRunMode("auto"), "mock");
    assert.throws(() => resolveRunMode("live"), ScreeningError);
    process.env.SCREENING_MODE = "mock";
    assert.equal(resolveRunMode("auto"), "mock");
  } finally {
    if (previousKey === undefined) delete process.env.VULTR_API_KEY;
    else process.env.VULTR_API_KEY = previousKey;
    if (previousAlt === undefined) delete process.env.VULTR_INFERENCE_API_KEY;
    else process.env.VULTR_INFERENCE_API_KEY = previousAlt;
    if (previousMode === undefined) delete process.env.SCREENING_MODE;
    else process.env.SCREENING_MODE = previousMode;
  }
});

test("the platform packet ranks on evidence and flags only the school-only degree", () => {
  const job = loadJobs().find((item) => item.id === "platform-engineer");
  const resumes = loadResumes();
  assert.ok(job);
  assert.equal(resumes.length, 6);
  const report = screenPacket({
    jobText: job.text,
    jobTitle: job.title,
    candidates: resumes.map((resume) => ({ id: resume.id, name: resume.name, text: resume.text })),
  });
  assert.equal(report.mode, "mock");
  assert.equal(report.requirementSource, "curated");
  const byName = new Map(report.ranked.map((item) => [item.name, item]));
  const amina = byName.get("Amina Shah");
  const robert = byName.get("Robert Okonkwo");
  const marcus = byName.get("Marcus Hale");
  const helen = byName.get("Helen Cho");
  const diego = byName.get("Diego Alvarez");
  const priya = byName.get("Priya Raman");
  assert.ok(amina && robert && marcus && helen && diego && priya);

  assert.equal(amina.result.recommendation, "advance");
  assert.equal(robert.result.recommendation, "advance");
  assert.equal(marcus.result.recommendation, "hold");
  assert.equal(helen.result.recommendation, "decline");
  assert.equal(diego.result.recommendation, "decline");
  assert.equal(priya.result.recommendation, "decline");
  assert.ok(amina.result.overall >= 85);
  assert.ok(robert.result.overall >= 85);

  const helenGaps = helen.result.requirementResults.filter((item) => item.status === "no_evidence").map((item) => item.requirementId);
  assert.ok(helenGaps.includes("kubernetes"));
  assert.ok(helenGaps.includes("payments"));
  const priyaYears = priya.result.requirementResults.find((item) => item.requirementId === "years");
  assert.equal(priyaYears?.status, "no_evidence");

  assert.equal(robert.blind.flagged, false);
  assert.ok(Math.abs(robert.blind.delta) < 8);
  assert.match(robert.blind.redactedText, /Kubernetes/);
  assert.match(robert.blind.redactedText, /PostgreSQL/);
  assert.doesNotMatch(robert.blind.redactedText, /54-year-old/);
  assert.doesNotMatch(robert.blind.redactedText, /father of three/);
  assert.doesNotMatch(robert.blind.redactedText, /headshot/);
  assert.doesNotMatch(robert.blind.redactedText, /Georgia Institute/);
  assert.doesNotMatch(robert.blind.redactedText, /Okonkwo/i);
  assert.doesNotMatch(robert.blind.redactedText, /@/);

  assert.equal(amina.blind.flagged, false);
  assert.match(amina.blind.redactedText, /production Kubernetes/);
  assert.match(amina.blind.redactedText, /ledger/);
  assert.doesNotMatch(amina.blind.redactedText, /\bShe\b/);
  assert.doesNotMatch(amina.blind.redactedText, /Waterloo/);

  assert.equal(helen.blind.flagged, true);
  const degree = helen.blind.requirementDeltas.find((item) => item.requirementId === "degree");
  assert.equal(degree?.beforeStatus, "partial");
  assert.equal(degree?.afterStatus, "no_evidence");
  assert.match(helen.blind.redactedText, /mentor/);
  assert.doesNotMatch(helen.blind.redactedText, /Stanford/);
  assert.doesNotMatch(helen.blind.redactedText, /\bwomen\b/i);

  const topTwo = report.ranked.slice(0, 2).map((item) => item.name).sort();
  assert.deepEqual(topTwo, ["Amina Shah", "Robert Okonkwo"]);
});

test("the people-partner packet advances only the people operator", () => {
  const job = loadJobs().find((item) => item.id === "people-partner");
  assert.ok(job);
  const report = screenPacket({
    jobText: job.text,
    candidates: loadResumes().map((resume) => ({ id: resume.id, name: resume.name, text: resume.text })),
  });
  const advances = report.ranked.filter((item) => item.result.recommendation === "advance").map((item) => item.name);
  assert.deepEqual(advances, ["Priya Raman"]);
  const priya = report.ranked.find((item) => item.name === "Priya Raman");
  assert.ok(priya);
  assert.ok(priya.result.overall >= 85);
  assert.equal(priya.result.mustHaveGaps, 0);
  assert.equal(priya.blind.flagged, false);
  assert.doesNotMatch(priya.blind.redactedText, /Howard University/);
  assert.match(priya.blind.redactedText, /Workday/);
  assert.match(priya.blind.redactedText, /full-cycle/);
});

test("edited job text leaves the curated rubric and uses the heuristic", () => {
  const job = loadJobs().find((item) => item.id === "platform-engineer");
  assert.ok(job);
  const report = screenPacket({
    jobText: `${job.text}\n- Extra bullet that changes the document.`,
    candidates: [{ id: "one", name: "Amina Shah", text: loadResumes()[0]?.text ?? "" }],
  });
  assert.equal(report.requirementSource, "heuristic");
});

test("blind review helper flags a large shift from a school-only citation", () => {
  const job = loadJobs().find((item) => item.id === "platform-engineer");
  const helen = loadResumes().find((item) => item.id === "helen-cho");
  assert.ok(job && helen);
  const review = buildBlindReview(helen.text, job.requirements, helen.name, helen.id, 8);
  assert.equal(review.flagged, true);
  assert.ok(review.delta <= -8);
});
