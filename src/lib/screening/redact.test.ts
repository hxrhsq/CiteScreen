import assert from "node:assert/strict";
import { test } from "node:test";
import { redactResume } from "./redact";
import { evaluateCandidate } from "./score";
import type { Requirement } from "./types";

const skill = "She led the migration of billing onto production Kubernetes.";

test("redacts name, pronoun, school, age, photo, and contact without eating the skill", () => {
  const resume = [
    "Amina Shah",
    "amina.shah@example.com · (415) 555-0148",
    "Photo attached: headshot-2024.jpg",
    "54-year-old engineering lead and father of three.",
    skill,
    "B.S. in Computer Science, University of Waterloo, 2016",
    "Employed 2019 - 2024 building services.",
    "Deployed the same chart on Heroku.",
    "Mr. Shah approved the design.",
  ].join("\n");
  const redacted = redactResume(resume, { name: "Amina Shah" });
  assert.match(redacted.text, /production Kubernetes/);
  assert.match(redacted.text, /2019 - 2024/);
  assert.match(redacted.text, /Heroku/);
  assert.match(redacted.text, /B\.S\./);
  assert.doesNotMatch(redacted.text, /\bAmina\b/);
  assert.doesNotMatch(redacted.text, /\bShah\b/);
  assert.doesNotMatch(redacted.text, /\bShe\b/);
  assert.doesNotMatch(redacted.text, /University of Waterloo/);
  assert.doesNotMatch(redacted.text, /54-year-old/);
  assert.doesNotMatch(redacted.text, /father of three/);
  assert.doesNotMatch(redacted.text, /headshot/);
  assert.doesNotMatch(redacted.text, /@/);
  assert.doesNotMatch(redacted.text, /555-0148/);
  assert.doesNotMatch(redacted.text, /Mr\./);
  const kinds = new Set(redacted.redactions.map((item) => item.kind));
  for (const kind of ["name", "gender", "school", "age", "photo", "contact"] as const) {
    assert.equal(kinds.has(kind), true, kind);
  }
});

test("born-in years and class years are ages, employment ranges are not", () => {
  const redacted = redactResume("Born in 1972.\nClass of 1994.\nHarbor Stack\n2016 - 2024 · Accra\n", {
    name: "Ada Lovelace",
  });
  assert.match(redacted.text, /\[AGE\]/);
  assert.doesNotMatch(redacted.text, /1972/);
  assert.doesNotMatch(redacted.text, /1994/);
  assert.match(redacted.text, /2016 - 2024/);
});

test("school-only degree evidence disappears under blind redaction, skill evidence does not", () => {
  const degree: Requirement = {
    id: "degree",
    category: "must_have",
    text: "A bachelor's degree from a university",
    keywords: ["bachelor", "university"],
    weakKeywords: ["university"],
    minMatches: 1,
    weight: 3,
  };
  const kubernetes: Requirement = {
    id: "kubernetes",
    category: "must_have",
    text: "Production Kubernetes",
    keywords: ["kubernetes", "production"],
    weakKeywords: [],
    minMatches: 2,
    weight: 3,
  };
  const resume = `Jordan Lee\nStanford University\n${skill}\n`;
  const original = evaluateCandidate({
    resume,
    requirements: [degree, kubernetes],
    candidateId: "j",
    name: "Jordan Lee",
  });
  const redacted = redactResume(resume, { name: "Jordan Lee" });
  const blind = evaluateCandidate({
    resume: redacted.text,
    requirements: [degree, kubernetes],
    candidateId: "j",
    name: "Jordan Lee",
  });
  assert.equal(original.requirementResults[0]?.status, "partial");
  assert.equal(blind.requirementResults[0]?.status, "no_evidence");
  assert.equal(original.requirementResults[1]?.status, "supported");
  assert.equal(blind.requirementResults[1]?.status, "supported");
  assert.ok(blind.overall < original.overall);
});
