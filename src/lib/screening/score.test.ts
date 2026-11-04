import assert from "node:assert/strict";
import { test } from "node:test";
import type { Requirement, RequirementResult } from "./types";
import { evaluateCandidate, overallScore, rankCandidates, recommend } from "./score";
import { lineMatchesKeyword } from "./text";

const years: Requirement = {
  id: "years",
  category: "must_have",
  text: "5+ years building backend services in Go or Python",
  keywords: ["backend", "go", "python"],
  weakKeywords: [],
  minMatches: 2,
  minYears: 5,
  weight: 3,
};

const kubernetes: Requirement = {
  id: "kubernetes",
  category: "must_have",
  text: "Production experience operating Kubernetes",
  keywords: ["kubernetes", "production"],
  weakKeywords: [],
  minMatches: 2,
  weight: 3,
};

const degree: Requirement = {
  id: "degree",
  category: "must_have",
  text: "A bachelor's degree from a university",
  keywords: ["bachelor", "university"],
  weakKeywords: ["university"],
  minMatches: 1,
  weight: 3,
};

test("does not treat the word go in 'to go' as the Go language", () => {
  assert.equal(lineMatchesKeyword("Ready to go to market next quarter.", "go"), false);
  assert.equal(lineMatchesKeyword("Services in Go and Python.", "go"), true);
  assert.equal(lineMatchesKeyword("Wrote golang services.", "go"), true);
});

test("degree abbreviations and plurals match without eating unrelated words", () => {
  assert.equal(lineMatchesKeyword("B.S. in Computer Science", "bachelor"), true);
  assert.equal(lineMatchesKeyword("B.A. Psychology", "bachelor"), true);
  assert.equal(lineMatchesKeyword("Designed PostgreSQL schemas", "schema"), true);
  assert.equal(lineMatchesKeyword("Heroku hosting", "her"), false);
});

test("a requirement with no verbatim line scores as no evidence", () => {
  const result = evaluateCandidate({
    resume: "Built marketing pages in HTML and CSS for local shops.",
    requirements: [kubernetes],
    candidateId: "c1",
    name: "Casey",
  });
  const scored = result.requirementResults[0];
  assert.ok(scored);
  assert.equal(scored.status, "no_evidence");
  assert.equal(scored.score, 0);
  assert.equal(scored.snippets.length, 0);
  assert.match(scored.rationale, /No evidence found/);
});

test("full keyword coverage with an explicit year count is supported", () => {
  const result = evaluateCandidate({
    resume: "8 years building backend services in Go and Python.",
    requirements: [years],
    candidateId: "c1",
    name: "Casey",
  });
  const scored = result.requirementResults[0];
  assert.ok(scored);
  assert.equal(scored.status, "supported");
  assert.ok(scored.score >= 90);
  assert.match(scored.snippets[0]?.text ?? "", /8 years/);
});

test("three years and a date range do not satisfy a 5+ year requirement", () => {
  const short = evaluateCandidate({
    resume: "3 years of backend Python work on internal tools.",
    requirements: [years],
    candidateId: "c1",
    name: "Casey",
  });
  assert.equal(short.requirementResults[0]?.status, "partial");
  assert.match(short.requirementResults[0]?.rationale ?? "", /3 years/);

  const ranged = evaluateCandidate({
    resume: "Built backend services in Go from 2016 - 2024.",
    requirements: [years],
    candidateId: "c1",
    name: "Casey",
  });
  assert.notEqual(ranged.requirementResults[0]?.status, "supported");
  assert.match(ranged.requirementResults[0]?.rationale ?? "", /never states a year count|date ranges/i);
});

test("a 54-year-old phrasing is not counted as years of experience", () => {
  const result = evaluateCandidate({
    resume: "54-year-old engineering lead.\nBuilt backend services in Go.",
    requirements: [years],
    candidateId: "c1",
    name: "Casey",
  });
  assert.notEqual(result.requirementResults[0]?.status, "supported");
});

test("fabricated quotes are discarded and cannot raise the score", () => {
  const result = evaluateCandidate({
    resume: "Built production Kubernetes clusters for billing.",
    requirements: [kubernetes],
    candidateId: "c1",
    name: "Casey",
    proposedQuotes: { kubernetes: ["Operated Kubernetes at a global bank for a decade."] },
  });
  assert.equal(result.requirementResults[0]?.status, "no_evidence");
  assert.equal(result.requirementResults[0]?.score, 0);
  assert.equal(result.requirementResults[0]?.discardedQuotes, 1);
  assert.match(result.requirementResults[0]?.rationale ?? "", /not a verbatim/i);
});

test("a verbatim quote is accepted and scored from the words inside it", () => {
  const quote = "Built production Kubernetes clusters for billing.";
  const result = evaluateCandidate({
    resume: `Intro\n${quote}\n`,
    requirements: [kubernetes],
    candidateId: "c1",
    name: "Casey",
    proposedQuotes: { kubernetes: [quote] },
  });
  assert.equal(result.requirementResults[0]?.status, "supported");
  assert.ok((result.requirementResults[0]?.snippets.length ?? 0) > 0);
});

test("whitespace inside a real quote still counts as verbatim", () => {
  const result = evaluateCandidate({
    resume: "Built  production   Kubernetes clusters for billing today.",
    requirements: [kubernetes],
    candidateId: "c1",
    name: "Casey",
    proposedQuotes: {
      kubernetes: ["Built production Kubernetes clusters for billing today."],
    },
  });
  assert.equal(result.requirementResults[0]?.status, "supported");
});

test("university alone is partial, and a stated degree is supported", () => {
  const onlySchool = evaluateCandidate({
    resume: "Stanford University",
    requirements: [degree],
    candidateId: "c1",
    name: "Casey",
  });
  assert.equal(onlySchool.requirementResults[0]?.status, "partial");
  assert.match(onlySchool.requirementResults[0]?.rationale ?? "", /weak signal/i);

  const stated = evaluateCandidate({
    resume: "B.S. in Computer Science, University of Waterloo, 2016",
    requirements: [degree],
    candidateId: "c1",
    name: "Casey",
  });
  assert.equal(stated.requirementResults[0]?.status, "supported");
});

test("CJK keywords match by substring", () => {
  const requirement: Requirement = {
    id: "recruit",
    category: "must_have",
    text: "负责招聘",
    keywords: ["招聘"],
    weakKeywords: [],
    minMatches: 1,
    weight: 3,
  };
  const result = evaluateCandidate({
    resume: "负责校园招聘与面试安排。",
    requirements: [requirement],
    candidateId: "c1",
    name: "Candidate",
  });
  assert.equal(result.requirementResults[0]?.status, "supported");
});

test("two missing must-haves decline, one missing must-have can hold, clean evidence advances", () => {
  const supported = (id: string): RequirementResult => ({
    requirementId: id,
    status: "supported",
    score: 100,
    snippets: [],
    matchedKeywords: [],
    missingKeywords: [],
    rationale: "",
    discardedQuotes: 0,
  });
  const missing = (id: string): RequirementResult => ({ ...supported(id), status: "no_evidence", score: 0 });
  const reqs = [years, kubernetes, degree];
  assert.equal(recommend(90, reqs, [supported("years"), supported("kubernetes"), supported("degree")]), "advance");
  assert.equal(recommend(70, reqs, [supported("years"), missing("kubernetes"), supported("degree")]), "hold");
  assert.equal(recommend(40, reqs, [missing("years"), missing("kubernetes"), supported("degree")]), "decline");
  assert.equal(overallScore(reqs, [supported("years"), missing("kubernetes"), supported("degree")]), 67);
});

test("ranking prefers the higher score, then fewer gaps, then name", () => {
  const base = {
    requirementResults: [],
    explanation: "",
  };
  const ranked = rankCandidates([
    { ...base, candidateId: "b", name: "Bea", overall: 70, mustHaveGaps: 1, recommendation: "hold" },
    { ...base, candidateId: "a", name: "Ada", overall: 70, mustHaveGaps: 0, recommendation: "hold" },
    { ...base, candidateId: "c", name: "Cy", overall: 90, mustHaveGaps: 2, recommendation: "decline" },
  ]);
  assert.deepEqual(ranked.map((item) => item.name), ["Cy", "Ada", "Bea"]);
});
