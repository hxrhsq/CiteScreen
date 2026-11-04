import type {
  CandidateResult,
  EvidenceStatus,
  Recommendation,
  Requirement,
  RequirementResult,
  Snippet,
} from "./types";
import { explicitYears, lineMatchesKeyword, locateVerbatim, splitLines } from "./text";

export function matchedKeywordsIn(text: string, keywords: string[]): string[] {
  return keywords.filter((keyword) => lineMatchesKeyword(text, keyword));
}

export function scoreSignals(input: {
  matched: string[];
  keywords: string[];
  minMatches: number;
  weakKeywords: string[];
  minYears?: number;
  yearsFound: number | null;
}): { status: EvidenceStatus; score: number; yearsMet: boolean } {
  if (input.matched.length === 0 || input.keywords.length === 0) {
    return { status: "no_evidence", score: 0, yearsMet: false };
  }
  const coverage = input.matched.length / input.keywords.length;
  const yearsRequired = typeof input.minYears === "number";
  const yearsMet =
    !yearsRequired || (input.yearsFound !== null && input.yearsFound >= (input.minYears ?? 0));
  const onlyWeak =
    input.weakKeywords.length > 0 &&
    input.matched.every((keyword) => input.weakKeywords.includes(keyword));
  const enough = input.matched.length >= input.minMatches && !onlyWeak && yearsMet;
  if (!enough) {
    const raw = Math.round(32 + 38 * coverage);
    const score = yearsRequired && !yearsMet ? Math.min(raw, 48) : raw;
    return { status: "partial", score, yearsMet };
  }
  return { status: "supported", score: Math.round(78 + 22 * coverage), yearsMet };
}

function buildRationale(input: {
  requirement: Requirement;
  status: EvidenceStatus;
  matched: string[];
  missing: string[];
  yearsMet: boolean;
  yearsFound: number | null;
  discardedQuotes: number;
  keptQuotes: number;
}): string {
  const { requirement, status, matched, missing, yearsMet, yearsFound, discardedQuotes, keptQuotes } =
    input;
  if (status === "no_evidence") {
    if (discardedQuotes > 0 && keptQuotes === 0) {
      return "No evidence found. The proposed quote is not a verbatim substring of the resume, so it was discarded and this requirement scored 0.";
    }
    return "No evidence found. No line in the resume states this, so it scored 0 instead of a guess.";
  }
  const cite = `Cited for: ${matched.join(", ")}.`;
  if (status === "partial" && requirement.minYears !== undefined && !yearsMet) {
    const stated =
      yearsFound === null
        ? "The resume never states a year count."
        : `The resume states ${yearsFound} years.`;
    return `Partial. ${stated} This requirement asks for ${requirement.minYears}+ years, and employment date ranges are not turned into tenure. ${cite}`;
  }
  if (status === "partial" && matched.every((keyword) => requirement.weakKeywords.includes(keyword))) {
    return `Partial. The only match is a weak signal (${matched.join(", ")}), with no stronger credential wording beside it. ${cite}`;
  }
  if (status === "partial") {
    const gap = missing.length > 0 ? ` Not cited: ${missing.join(", ")}.` : "";
    return `Partial. ${cite}${gap}`;
  }
  return `Supported. ${cite}`;
}

type PickedLine = {
  text: string;
  start: number;
  end: number;
  matched: string[];
  years: number | null;
};

export function findEvidence(
  resume: string,
  requirement: Requirement,
): { snippets: Snippet[]; matchedKeywords: string[]; yearsFound: number | null } {
  const annotated: PickedLine[] = splitLines(resume).map((line) => ({
    ...line,
    matched: matchedKeywordsIn(line.text, requirement.keywords),
    years: explicitYears(line.text),
  }));
  const withHits = annotated
    .filter((line) => line.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length || a.start - b.start);

  const picked: PickedLine[] = [];
  const covered = new Set<string>();
  for (const line of withHits) {
    if (picked.length >= 3) break;
    const novel = line.matched.some((keyword) => !covered.has(keyword));
    if (picked.length === 0 || novel) {
      picked.push(line);
      for (const keyword of line.matched) covered.add(keyword);
    }
  }

  if (
    requirement.minYears !== undefined &&
    !picked.some((line) => line.years !== null && line.years >= requirement.minYears!)
  ) {
    const yearLine = annotated
      .filter((line) => line.years !== null)
      .sort((a, b) => (b.years ?? 0) - (a.years ?? 0))[0];
    if (yearLine && !picked.includes(yearLine)) picked.push(yearLine);
  }

  const blob = picked.map((line) => line.text).join("\n");
  const matchedKeywords = matchedKeywordsIn(blob, requirement.keywords);
  let yearsFound: number | null = null;
  for (const line of picked) {
    if (line.years === null) continue;
    yearsFound = yearsFound === null ? line.years : Math.max(yearsFound, line.years);
  }
  return {
    snippets: picked.map((line) => ({ text: line.text, start: line.start, end: line.end })),
    matchedKeywords,
    yearsFound,
  };
}

function fromSnippets(
  requirement: Requirement,
  snippets: Snippet[],
  discardedQuotes: number,
): RequirementResult {
  const blob = snippets.map((snippet) => snippet.text).join("\n");
  const matched = matchedKeywordsIn(blob, requirement.keywords);
  const missing = requirement.keywords.filter((keyword) => !matched.includes(keyword));
  let yearsFound: number | null = null;
  for (const snippet of snippets) {
    const years = explicitYears(snippet.text);
    if (years === null) continue;
    yearsFound = yearsFound === null ? years : Math.max(yearsFound, years);
  }
  const judged = scoreSignals({
    matched,
    keywords: requirement.keywords,
    minMatches: requirement.minMatches,
    weakKeywords: requirement.weakKeywords,
    minYears: requirement.minYears,
    yearsFound,
  });
  return {
    requirementId: requirement.id,
    status: judged.status,
    score: judged.score,
    snippets: judged.status === "no_evidence" ? [] : snippets,
    matchedKeywords: judged.status === "no_evidence" ? [] : matched,
    missingKeywords: missing,
    discardedQuotes,
    rationale: buildRationale({
      requirement,
      status: judged.status,
      matched: judged.status === "no_evidence" ? [] : matched,
      missing,
      yearsMet: judged.yearsMet,
      yearsFound,
      discardedQuotes,
      keptQuotes: snippets.length,
    }),
  };
}

export function evaluateCandidate(input: {
  resume: string;
  requirements: Requirement[];
  candidateId: string;
  name: string;
  /** When set, only these quotes are eligible. Unverified quotes are discarded. */
  proposedQuotes?: Record<string, string[]>;
}): CandidateResult {
  const requirementResults = input.requirements.map((requirement) => {
    if (input.proposedQuotes) {
      const quotes = input.proposedQuotes[requirement.id] ?? [];
      const snippets: Snippet[] = [];
      let discarded = 0;
      for (const quote of quotes) {
        const located = locateVerbatim(input.resume, quote);
        if (!located) {
          discarded += 1;
          continue;
        }
        snippets.push({ text: located.text, start: located.start, end: located.end });
      }
      return fromSnippets(requirement, snippets, discarded);
    }
    const found = findEvidence(input.resume, requirement);
    return fromSnippets(requirement, found.snippets, 0);
  });
  const overall = overallScore(input.requirements, requirementResults);
  const mustHaveGaps = countMustHaveGaps(input.requirements, requirementResults);
  const recommendation = recommend(overall, input.requirements, requirementResults);
  return {
    candidateId: input.candidateId,
    name: input.name,
    requirementResults,
    overall,
    mustHaveGaps,
    recommendation,
    explanation: explainRecommendation(recommendation, overall, input.requirements, requirementResults),
  };
}

export function overallScore(requirements: Requirement[], results: RequirementResult[]): number {
  let weight = 0;
  let sum = 0;
  for (const requirement of requirements) {
    const result = results.find((item) => item.requirementId === requirement.id);
    weight += requirement.weight;
    sum += (result?.score ?? 0) * requirement.weight;
  }
  if (weight === 0) return 0;
  return Math.round(sum / weight);
}

export function countMustHaveGaps(requirements: Requirement[], results: RequirementResult[]): number {
  return requirements.filter((requirement) => {
    if (requirement.category !== "must_have") return false;
    const result = results.find((item) => item.requirementId === requirement.id);
    return !result || result.status === "no_evidence";
  }).length;
}

export function recommend(
  overall: number,
  requirements: Requirement[],
  results: RequirementResult[],
): Recommendation {
  const gaps = countMustHaveGaps(requirements, results);
  const mustResults = requirements
    .filter((requirement) => requirement.category === "must_have")
    .map((requirement) => results.find((item) => item.requirementId === requirement.id))
    .filter((item): item is RequirementResult => Boolean(item));
  if (gaps >= 2) return "decline";
  if (gaps === 1) return overall >= 60 ? "hold" : "decline";
  if (overall >= 80 && mustResults.every((item) => item.status === "supported")) return "advance";
  if (overall >= 64) return "hold";
  return "decline";
}

export function explainRecommendation(
  recommendation: Recommendation,
  overall: number,
  requirements: Requirement[],
  results: RequirementResult[],
): string {
  const label =
    recommendation === "advance" ? "Advance" : recommendation === "hold" ? "Hold" : "Do not advance";
  const gaps = requirements.filter((requirement) => {
    if (requirement.category !== "must_have") return false;
    const result = results.find((item) => item.requirementId === requirement.id);
    return result?.status === "no_evidence";
  });
  if (gaps.length > 0) {
    const names = gaps.map((requirement) => requirement.text).join("; ");
    return `${label}. No evidence found for ${gaps.length} must-have requirement${gaps.length === 1 ? "" : "s"}: ${names}. Those scores stay at 0. Nothing was inferred to fill the gap. Overall evidence score ${overall}.`;
  }
  if (recommendation === "advance") {
    return `Advance. Every must-have requirement has a verbatim citation. Overall evidence score ${overall}.`;
  }
  const partials = results.filter((item) => item.status === "partial").length;
  return `${label}. Overall evidence score ${overall}. ${partials} requirement${partials === 1 ? " is" : "s are"} only partial, so this is not a clean advance.`;
}

export function rankCandidates(results: CandidateResult[]): CandidateResult[] {
  return [...results].sort((a, b) => {
    if (b.overall !== a.overall) return b.overall - a.overall;
    if (a.mustHaveGaps !== b.mustHaveGaps) return a.mustHaveGaps - b.mustHaveGaps;
    return a.name.localeCompare(b.name);
  });
}
