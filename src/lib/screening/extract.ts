import type { Category, Requirement } from "./types";
import { clamp, isCjk } from "./text";

const PHRASES = [
  "computer science",
  "distributed systems",
  "people operations",
  "human resources",
  "employee relations",
  "hiring manager",
  "performance review",
  "people analytics",
  "machine learning",
  "project management",
  "full-cycle",
  "full cycle",
  "on-call",
  "on call",
  "multi-state",
  "multi state",
];

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "you",
  "your",
  "our",
  "will",
  "this",
  "that",
  "from",
  "into",
  "over",
  "per",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "been",
  "being",
  "who",
  "what",
  "when",
  "where",
  "how",
  "all",
  "any",
  "can",
  "may",
  "must",
  "should",
  "able",
  "using",
  "use",
  "used",
  "work",
  "working",
  "role",
  "team",
  "teams",
  "plus",
  "than",
  "more",
  "including",
  "include",
  "across",
  "other",
  "such",
  "both",
  "their",
  "they",
  "them",
  "its",
  "it's",
  "not",
  "but",
  "about",
  "after",
  "before",
  "years",
  "year",
  "experience",
  "experienced",
]);

export function keywordsFrom(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  let rest = lower;
  for (const phrase of PHRASES) {
    if (!lower.includes(phrase)) continue;
    const stored = phrase.startsWith("full")
      ? "full-cycle"
      : phrase.startsWith("on")
        ? "on-call"
        : phrase.startsWith("multi")
          ? "multi-state"
          : phrase;
    if (!found.includes(stored)) found.push(stored);
    rest = rest.replaceAll(phrase, " ");
  }
  const tokens = rest
    .split(/[^a-z0-9+#.\u3400-\u9fff]+/i)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3 && !STOP.has(token) && !/^\d+$/.test(token));
  for (const token of tokens) {
    if (found.includes(token)) continue;
    found.push(token);
    if (found.length >= 6) break;
  }
  if (isCjk(lower)) {
    for (const run of lower.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
      if (!found.includes(run)) found.push(run);
    }
  }
  return found.slice(0, 6);
}

export function detectMinYears(text: string): number | undefined {
  const match = text.match(/\b(\d{1,2})\s*\+\s*years?\b/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 1 || value > 40) return undefined;
  return value;
}

export function weightFor(category: Category): number {
  if (category === "must_have") return 3;
  if (category === "responsibility") return 2;
  return 1;
}

export function deriveRequirement(text: string, category: Category, id: string): Requirement {
  const extracted = keywordsFrom(text);
  const fallback = text
    .toLowerCase()
    .split(/[^a-z0-9+#.\u3400-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 4);
  const keywords = extracted.length > 0 ? extracted : fallback.length > 0 ? fallback : ["requirement"];
  const minYears = detectMinYears(text);
  const minMatches = keywords.length <= 2 ? 1 : Math.min(2, keywords.length);
  const weakKeywords = keywords.filter((keyword) => keyword === "university" || keyword === "college");
  return {
    id,
    category,
    text: text.trim().replace(/\s+/g, " "),
    keywords,
    weakKeywords,
    minMatches: Math.max(1, Math.min(minMatches, Math.max(keywords.length, 1))),
    minYears,
    weight: weightFor(category),
  };
}

function categoryFromHeader(header: string): Category | null {
  const value = header.toLowerCase().replace(/[:：]\s*$/, "").trim();
  if (
    /^(requirements|qualifications|what you bring|what you'll bring|what you will bring|must[ -]?haves?|required)$/.test(
      value,
    )
  ) {
    return "must_have";
  }
  if (/^(preferred|nice to have|nice-to-have|bonus|plus|good to have)$/.test(value)) {
    return "nice_to_have";
  }
  if (/^(responsibilities|what you'll do|what you will do|the role)$/.test(value)) {
    return "responsibility";
  }
  return null;
}

export function heuristicExtract(jobText: string): Requirement[] {
  const requirements: Requirement[] = [];
  let category: Category | null = null;
  const lines = jobText.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const header = categoryFromHeader(trimmed);
    if (header) {
      category = header;
      continue;
    }
    const bullet = trimmed.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (!bullet || !category) continue;
    const text = bullet[1].trim();
    if (text.length < 3) continue;
    requirements.push(deriveRequirement(text, category, `req-${requirements.length + 1}`));
    if (requirements.length >= 16) break;
  }
  return requirements;
}

function asCategory(value: unknown): Category {
  const text = String(value ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["nice_to_have", "nice", "preferred", "bonus"].includes(text)) return "nice_to_have";
  if (["responsibility", "responsibilities", "duty"].includes(text)) return "responsibility";
  return "must_have";
}

export function sanitizeRequirements(input: unknown): Requirement[] {
  if (!Array.isArray(input)) return [];
  const cleaned: Requirement[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = String(record.text ?? "").trim();
    if (text.length < 3 || text.length > 400) continue;
    const category = asCategory(record.category);
    const id = String(record.id ?? `req-${cleaned.length + 1}`)
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 40);
    const keywords = Array.isArray(record.keywords)
      ? record.keywords
          .map((keyword) => String(keyword).trim().toLowerCase())
          .filter((keyword) => keyword.length >= 2 && keyword.length <= 40)
          .slice(0, 8)
      : keywordsFrom(text);
    const uniqueKeywords = [...new Set(keywords.length > 0 ? keywords : keywordsFrom(text))].slice(0, 8);
    if (uniqueKeywords.length === 0) continue;
    const weakKeywords = Array.isArray(record.weakKeywords)
      ? record.weakKeywords.map((keyword) => String(keyword).toLowerCase()).filter((keyword) => uniqueKeywords.includes(keyword))
      : uniqueKeywords.filter((keyword) => keyword === "university" || keyword === "college");
    const minMatches = clamp(Number(record.minMatches ?? 1) || 1, 1, uniqueKeywords.length);
    const minYearsRaw = record.minYears;
    const minYears =
      minYearsRaw === null || minYearsRaw === undefined || minYearsRaw === ""
        ? undefined
        : clamp(Number(minYearsRaw), 1, 40);
    const weight = clamp(Number(record.weight ?? weightFor(category)) || weightFor(category), 1, 3);
    cleaned.push({
      id: id || `req-${cleaned.length + 1}`,
      category,
      text,
      keywords: uniqueKeywords,
      weakKeywords,
      minMatches,
      minYears: Number.isFinite(minYears) ? minYears : undefined,
      weight,
    });
  }
  return cleaned;
}

export function coerceModelRequirements(payload: unknown): Requirement[] {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(record.requirements) ? record.requirements : [];
  return sanitizeRequirements(
    list.map((item, index) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const text = String(row.text ?? "").trim();
      return {
        id: String(row.id ?? `req-${index + 1}`),
        category: row.category,
        text,
        keywords: Array.isArray(row.keywords) ? row.keywords : keywordsFrom(text),
        weakKeywords: row.weakKeywords,
        minMatches: row.minMatches,
        minYears: row.minYears,
        weight: row.weight,
      };
    }),
  );
}
