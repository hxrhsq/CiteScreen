import { inferenceConfig, resolveModel, resolveRunMode, ScreeningError } from "../config";
import { sanitizeRequirements } from "./extract";
import { redactResume } from "./redact";
import { evaluateCandidate, rankCandidates } from "./score";
import { resolveRequirements } from "./samples";
import type {
  BlindReview,
  RankedCandidate,
  Requirement,
  RequirementSource,
  ScreenInput,
  ScreenReport,
} from "./types";

function displayName(text: string, hint?: string): string {
  const trimmed = hint?.trim();
  if (trimmed) return trimmed.slice(0, 80);
  const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line?.slice(0, 80) || "Unnamed candidate";
}

export function buildBlindReview(
  resume: string,
  requirements: Requirement[],
  originalName: string,
  candidateId: string,
  threshold: number,
  original = evaluateCandidate({
    resume,
    requirements,
    candidateId,
    name: originalName,
  }),
): BlindReview {
  const redacted = redactResume(resume, { name: originalName });
  const blindResult = evaluateCandidate({
    resume: redacted.text,
    requirements,
    candidateId,
    name: originalName,
  });
  const delta = blindResult.overall - original.overall;
  const requirementDeltas = requirements.map((requirement) => {
    const before = original.requirementResults.find((item) => item.requirementId === requirement.id);
    const after = blindResult.requirementResults.find((item) => item.requirementId === requirement.id);
    return {
      requirementId: requirement.id,
      text: requirement.text,
      beforeScore: before?.score ?? 0,
      afterScore: after?.score ?? 0,
      beforeStatus: before?.status ?? "no_evidence",
      afterStatus: after?.status ?? "no_evidence",
    };
  });
  const lost = requirementDeltas.filter(
    (item) => item.beforeStatus !== "no_evidence" && item.afterStatus === "no_evidence",
  );
  const reasons: string[] = [];
  if (Math.abs(delta) >= threshold) {
    const sign = delta > 0 ? "+" : "";
    reasons.push(`Overall score moved ${sign}${delta}, at or above the ${threshold}-point bar.`);
  }
  if (lost.length > 0) {
    reasons.push(
      `Evidence disappeared after redaction for: ${lost.map((item) => item.text).join("; ")}.`,
    );
  }
  if (reasons.length === 0) {
    const kinds = [...new Set(redacted.redactions.map((item) => item.kind))];
    const removed = kinds.length > 0 ? kinds.join(", ") : "no protected tokens";
    reasons.push(
      `Score moved ${delta > 0 ? "+" : ""}${delta} after redacting ${removed}. That is under the ${threshold}-point bar, and no requirement lost all of its citations.`,
    );
  }
  return {
    redactedText: redacted.text,
    redactions: redacted.redactions,
    result: blindResult,
    delta,
    flagged: Math.abs(delta) >= threshold || lost.length > 0,
    reasons,
    requirementDeltas,
  };
}

export function screenPacket(input: ScreenInput & { requirementSource?: RequirementSource; modelLabel?: string; modeLabel?: "mock" | "live" }): ScreenReport {
  const started = Date.now();
  if (!input.jobText?.trim()) throw new ScreeningError("Paste a job description first.");
  if (!input.candidates?.length) throw new ScreeningError("Add at least one resume.");
  if (input.candidates.length > 8) throw new ScreeningError("Screen up to 8 resumes at a time.");

  let requirements: Requirement[];
  let source: RequirementSource;
  let jobTitle = input.jobTitle?.trim() || "";
  if (input.requirements && input.requirements.length > 0) {
    requirements = sanitizeRequirements(input.requirements);
    source = input.requirementSource ?? "provided";
    if (!jobTitle) jobTitle = input.jobText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Untitled role";
  } else {
    const resolved = resolveRequirements(input.jobText);
    requirements = resolved.requirements;
    source = resolved.source;
    jobTitle = jobTitle || resolved.jobTitle;
  }
  if (requirements.length === 0) {
    throw new ScreeningError(
      "No requirements were found. Use bullets under Requirements, Preferred, or Responsibilities, or load a sample job.",
    );
  }

  const threshold = input.threshold ?? inferenceConfig().threshold;
  const evaluated = input.candidates.map((candidate, index) => {
    const text = candidate.text ?? "";
    if (text.trim().length < 20) {
      throw new ScreeningError(`Resume ${index + 1} is too short to screen.`);
    }
    const name = displayName(text, candidate.name);
    const result = evaluateCandidate({
      resume: text,
      requirements,
      candidateId: candidate.id || `candidate-${index + 1}`,
      name,
    });
    const blind = buildBlindReview(text, requirements, name, result.candidateId, threshold, result);
    return { result, blind };
  });
  const rankedResults = rankCandidates(evaluated.map((item) => item.result));
  const ranked: RankedCandidate[] = rankedResults.map((result, index) => {
    const pair = evaluated.find((item) => item.result.candidateId === result.candidateId);
    if (!pair) throw new ScreeningError("Ranking failed to keep a candidate.");
    return {
      rank: index + 1,
      candidateId: result.candidateId,
      name: result.name,
      result,
      blind: pair.blind,
    };
  });

  return {
    mode: input.modeLabel ?? "mock",
    model: input.modelLabel ?? "deterministic-mock",
    requirementSource: source,
    requirements,
    threshold,
    elapsedMs: Date.now() - started,
    jobTitle,
    ranked,
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function screenWithMode(input: ScreenInput): Promise<ScreenReport> {
  const mode = resolveRunMode(input.mode);
  const model = resolveModel(input.model);
  if (mode === "mock") {
    return screenPacket({ ...input, modeLabel: "mock", modelLabel: "deterministic-mock" });
  }

  const started = Date.now();
  const llm = await import("./llm");
  let requirements: Requirement[];
  let source: RequirementSource;
  const jobTitle = input.jobTitle?.trim() || input.jobText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "Untitled role";
  if (input.requirements && input.requirements.length > 0) {
    requirements = sanitizeRequirements(input.requirements);
    source = "provided";
  } else {
    requirements = await llm.llmExtractRequirements(input.jobText, model);
    source = "model";
  }
  if (!input.candidates?.length) throw new ScreeningError("Add at least one resume.");

  const threshold = input.threshold ?? inferenceConfig().threshold;
  const evaluated = await mapPool(input.candidates, 3, async (candidate, index) => {
    const name = displayName(candidate.text, candidate.name);
    const id = candidate.id || `candidate-${index + 1}`;
    const [originalQuotes, blindQuotes] = await Promise.all([
      llm.llmProposeQuotes({ resume: candidate.text, requirements, model }),
      llm.llmProposeQuotes({
        resume: redactResume(candidate.text, { name }).text,
        requirements,
        model,
      }),
    ]);
    const result = evaluateCandidate({
      resume: candidate.text,
      requirements,
      candidateId: id,
      name,
      proposedQuotes: originalQuotes,
    });
    const redacted = redactResume(candidate.text, { name });
    const blindResult = evaluateCandidate({
      resume: redacted.text,
      requirements,
      candidateId: id,
      name,
      proposedQuotes: blindQuotes,
    });
    const blind = buildBlindReview(candidate.text, requirements, name, id, threshold, result);
    // Replace the finder-based blind score with the verified model quotes on the redacted text.
    const delta = blindResult.overall - result.overall;
    const requirementDeltas = requirements.map((requirement) => {
      const before = result.requirementResults.find((item) => item.requirementId === requirement.id);
      const after = blindResult.requirementResults.find((item) => item.requirementId === requirement.id);
      return {
        requirementId: requirement.id,
        text: requirement.text,
        beforeScore: before?.score ?? 0,
        afterScore: after?.score ?? 0,
        beforeStatus: before?.status ?? "no_evidence",
        afterStatus: after?.status ?? "no_evidence",
      };
    });
    const lost = requirementDeltas.filter(
      (item) => item.beforeStatus !== "no_evidence" && item.afterStatus === "no_evidence",
    );
    const reasons: string[] = [];
    if (Math.abs(delta) >= threshold) {
      reasons.push(`Overall score moved ${delta > 0 ? "+" : ""}${delta}, at or above the ${threshold}-point bar.`);
    }
    if (lost.length > 0) {
      reasons.push(`Evidence disappeared after redaction for: ${lost.map((item) => item.text).join("; ")}.`);
    }
    if (reasons.length === 0) {
      reasons.push(
        `Score moved ${delta > 0 ? "+" : ""}${delta} after the redacted resume was quoted again. Under the ${threshold}-point bar.`,
      );
    }
    return {
      result,
      blind: {
        ...blind,
        result: blindResult,
        delta,
        flagged: Math.abs(delta) >= threshold || lost.length > 0,
        reasons,
        requirementDeltas,
      },
    };
  });

  const rankedResults = rankCandidates(evaluated.map((item) => item.result));
  const ranked: RankedCandidate[] = rankedResults.map((result, index) => {
    const pair = evaluated.find((item) => item.result.candidateId === result.candidateId);
    if (!pair) throw new ScreeningError("Ranking failed to keep a candidate.");
    return { rank: index + 1, candidateId: result.candidateId, name: result.name, result, blind: pair.blind };
  });

  return {
    mode,
    model,
    requirementSource: source,
    requirements,
    threshold,
    elapsedMs: Date.now() - started,
    jobTitle,
    ranked,
  };
}
