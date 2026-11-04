export type Category = "must_have" | "nice_to_have" | "responsibility";

export type EvidenceStatus = "supported" | "partial" | "no_evidence";

export type Recommendation = "advance" | "hold" | "decline";

export type RunMode = "mock" | "live";

export type RequestedMode = "auto" | RunMode;

export type Requirement = {
  id: string;
  category: Category;
  text: string;
  keywords: string[];
  /** Matches that are real words in the resume but weak proof on their own. */
  weakKeywords: string[];
  /** How many distinct keywords must be cited for a full "supported" score. */
  minMatches: number;
  /** When set, the resume must state a number of years at least this large. Date ranges do not count. */
  minYears?: number;
  weight: number;
};

export type Snippet = {
  text: string;
  start: number;
  end: number;
};

export type RequirementResult = {
  requirementId: string;
  status: EvidenceStatus;
  score: number;
  snippets: Snippet[];
  matchedKeywords: string[];
  missingKeywords: string[];
  rationale: string;
  discardedQuotes: number;
};

export type CandidateResult = {
  candidateId: string;
  name: string;
  requirementResults: RequirementResult[];
  overall: number;
  mustHaveGaps: number;
  recommendation: Recommendation;
  explanation: string;
};

export type RedactionKind = "name" | "gender" | "photo" | "school" | "age" | "contact";

export type Redaction = {
  kind: RedactionKind;
  original: string;
  replacement: string;
};

export type RequirementDelta = {
  requirementId: string;
  text: string;
  beforeScore: number;
  afterScore: number;
  beforeStatus: EvidenceStatus;
  afterStatus: EvidenceStatus;
};

export type BlindReview = {
  redactedText: string;
  redactions: Redaction[];
  result: CandidateResult;
  delta: number;
  flagged: boolean;
  reasons: string[];
  requirementDeltas: RequirementDelta[];
};

export type RankedCandidate = {
  rank: number;
  candidateId: string;
  name: string;
  result: CandidateResult;
  blind: BlindReview;
};

export type RequirementSource = "curated" | "heuristic" | "provided" | "model";

export type ScreenReport = {
  mode: RunMode;
  model: string;
  requirementSource: RequirementSource;
  requirements: Requirement[];
  threshold: number;
  elapsedMs: number;
  jobTitle: string;
  ranked: RankedCandidate[];
};

export type AuditEvent = {
  id: string;
  at: string;
  jobTitle: string;
  candidateId: string;
  candidateName: string;
  mode: RunMode;
  model: string;
  systemRecommendation: Recommendation;
  systemScore: number;
  decision: Recommendation;
  override: boolean;
  note: string;
  blindScore: number | null;
  blindDelta: number | null;
  fairnessFlag: boolean | null;
};

export type ScreenCandidateInput = {
  id: string;
  name?: string;
  text: string;
};

export type ScreenInput = {
  jobText: string;
  jobTitle?: string;
  candidates: ScreenCandidateInput[];
  requirements?: Requirement[];
  threshold?: number;
  mode?: RequestedMode;
  model?: string;
};
