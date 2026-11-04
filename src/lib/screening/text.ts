const ALIASES: Record<string, string[]> = {
  go: ["golang", "go"],
  golang: ["golang", "go"],
  postgresql: ["postgresql", "postgres"],
  postgres: ["postgresql", "postgres"],
  kubernetes: ["kubernetes", "k8s"],
  k8s: ["kubernetes", "k8s"],
  "on-call": ["on-call", "on call"],
  "on call": ["on-call", "on call"],
  bachelor: ["bachelor"],
  mentor: ["mentor", "mentored", "mentoring"],
  mentored: ["mentor", "mentored", "mentoring"],
  payment: ["payment", "payments"],
  payments: ["payment", "payments"],
  transaction: ["transaction", "transactions"],
  recruiting: ["recruiting", "recruitment", "recruiter"],
  recruitment: ["recruiting", "recruitment", "recruiter"],
  bamboohr: ["bamboohr", "bamboo hr"],
  hris: ["hris"],
  workday: ["workday"],
  investigation: ["investigation", "investigations"],
  onboarding: ["onboarding"],
  university: ["university", "college", "institute"],
};

const DEGREE_SRC =
  String.raw`(?:\b(?:bachelor(?:'?s)?|bachelors|master(?:'?s)?|masters|doctorate|phd)\b|\b(?:b\.?\s?s|b\.?\s?a|b\.?\s?sc|m\.?\s?s|m\.?\s?a|ph\.?\s?d)\.?(?!\w))`;

const GO_SRC = String.raw`\b(?:golang|(?<!(?:to|let)\s)go)\b`;

export function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function phraseSource(phrase: string): string {
  const tokens = phrase
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(escapeReg);
  if (tokens.length === 0) return "$^";
  return String.raw`\b${tokens.join(String.raw`[\s-]+`)}s?\b`;
}

export function keywordPattern(keyword: string): RegExp {
  const key = keyword.toLowerCase().trim();
  if (key === "bachelor" || key === "degree") return new RegExp(DEGREE_SRC, "i");
  if (key === "go" || key === "golang") return new RegExp(GO_SRC, "i");
  if (isCjk(key)) return new RegExp(escapeReg(key), "i");
  const aliases = ALIASES[key] ?? [key];
  const parts = aliases.map((alias) => {
    if (alias === "go" || alias === "golang") return GO_SRC;
    if (alias === "bachelor") return DEGREE_SRC;
    return phraseSource(alias);
  });
  return new RegExp(parts.join("|"), "i");
}

export function lineMatchesKeyword(text: string, keyword: string): boolean {
  if (!keyword.trim()) return false;
  return keywordPattern(keyword).test(text);
}

export function explicitYears(text: string): number | null {
  const re = /\b(\d{1,2})\s*[-+]?\s*years?\b(?!\s*[- ]?old\b)/gi;
  let max: number | null = null;
  for (const match of text.matchAll(re)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

export type LineSpan = {
  text: string;
  start: number;
  end: number;
};

export function splitLines(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  for (const match of text.matchAll(/[^\n\r]+/g)) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lead = raw.indexOf(trimmed);
    const start = (match.index ?? 0) + lead;
    if (trimmed.length <= 320) {
      lines.push({ text: trimmed, start, end: start + trimmed.length });
      continue;
    }
    const sentenceRe = /[^.!?]+[.!?]+|[^.!?]+$/g;
    for (const sentence of trimmed.matchAll(sentenceRe)) {
      const piece = sentence[0].trim();
      if (!piece) continue;
      const inner = sentence[0].indexOf(piece);
      const sentenceStart = start + (sentence.index ?? 0) + inner;
      lines.push({ text: piece, start: sentenceStart, end: sentenceStart + piece.length });
    }
  }
  return lines;
}

export function locateVerbatim(
  haystack: string,
  needle: string,
): { start: number; end: number; text: string } | null {
  const trimmed = needle.trim();
  if (trimmed.length < 12) return null;
  const exact = haystack.indexOf(trimmed);
  if (exact >= 0) {
    return { start: exact, end: exact + trimmed.length, text: trimmed };
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean).map(escapeReg);
  if (tokens.length === 0) return null;
  const flexible = new RegExp(tokens.join(String.raw`\s+`));
  const match = flexible.exec(haystack);
  if (!match || match[0].length < 12) return null;
  return { start: match.index, end: match.index + match[0].length, text: match[0] };
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
