import type { Redaction, RedactionKind } from "./types";

const TOKEN: Record<RedactionKind, string> = {
  name: "[NAME]",
  gender: "[GENDER]",
  photo: "[PHOTO]",
  school: "[SCHOOL]",
  age: "[AGE]",
  contact: "[CONTACT]",
};

const PRIORITY: Record<RedactionKind, number> = {
  photo: 6,
  contact: 5,
  age: 4,
  school: 3,
  gender: 2,
  name: 1,
};

type Span = {
  start: number;
  end: number;
  kind: RedactionKind;
};

const SCHOOL_PATTERNS = [
  /\bUniversity\s+of\s+[A-Z][\w.'-]+(?:(?:\s*,\s*|\s+)[A-Z][\w.'-]+){0,3}/g,
  /\b(?:[A-Z][\w.'-]+\s+){1,4}University\b/g,
  /\b(?:[A-Z][\w.'-]+\s+){0,3}Institute\s+of\s+Technology\b/g,
  /\b(?:[A-Z][\w.'-]+\s+){1,3}College\b/g,
  /\bCollege\s+of\s+[A-Z][\w.'-]+(?:(?:\s*,\s*|\s+)[A-Z][\w.'-]+){0,2}/g,
  /\b(?:[A-Z][\w.'-]+\s+){1,3}(?:Bootcamp|Academy)\b/g,
  /\b(?:MIT|CMU|UCLA|USC|NYU|ETH|EPFL|NUS|UIUC|Caltech|Georgia Tech)\b/g,
];

const GENDER_RE =
  /\b(?:women|woman|female|males|male|men|man|non-binary|nonbinary|girls|girl|boys|boy|mothers|mother|fathers|father|moms|mom|dads|dad|maternity|paternity|herself|himself|hers|she|her|him|his|he)\b/gi;

function collect(text: string, re: RegExp, kind: RedactionKind, offset = 0): Span[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const pattern = new RegExp(re.source, flags);
  const spans: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    const start = offset + (match.index ?? 0);
    spans.push({ start, end: start + match[0].length, kind });
  }
  return spans;
}

export function detectName(text: string, hint?: string): string | null {
  const hinted = hint?.trim();
  if (hinted && /^[\p{L}][\p{L}'.-]+(?:\s+[\p{L}][\p{L}'.-]+){0,3}$/u.test(hinted)) {
    return hinted;
  }
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return null;
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(line)) return line;
  return null;
}

function nameSpans(text: string, name: string | null): Span[] {
  if (!name) return [];
  const parts = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
  const spans: Span[] = [];
  for (const part of parts) {
    const re = new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    spans.push(...collect(text, re, "name"));
  }
  return spans;
}

function schoolSpans(text: string): Span[] {
  const spans: Span[] = [];
  const lineRe = /[^\n\r]+/g;
  for (const line of text.matchAll(lineRe)) {
    const slice = line[0];
    const offset = line.index ?? 0;
    for (const pattern of SCHOOL_PATTERNS) {
      spans.push(...collect(slice, pattern, "school", offset));
    }
  }
  return spans;
}

export function redactResume(text: string, options?: { name?: string }): {
  text: string;
  redactions: Redaction[];
  name: string | null;
} {
  const name = detectName(text, options?.name);
  const spans: Span[] = [
    ...collect(text, /!\[[^\]]*\]\([^)]+\)/g, "photo"),
    ...collect(text, /\bdata:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, "photo"),
    ...collect(
      text,
      /\b(?:headshot|profile photo|passport photo|photo attached|photograph attached)\b[^\n]*/gi,
      "photo",
    ),
    ...collect(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "contact"),
    ...collect(text, /\b(?:\+?\d{1,3}[-.\s])?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}\b/g, "contact"),
    ...collect(text, /\bhttps?:\/\/\S+/gi, "contact"),
    ...collect(text, /\blinkedin\.com\/\S+/gi, "contact"),
    ...collect(text, /\b\d{1,3}\s*[- ]years?\s*[- ]old\b/gi, "age"),
    ...collect(text, /\bage(?:d)?\s*:?\s*\d{1,3}\b/gi, "age"),
    ...collect(
      text,
      /\bborn(?:\s+on)?(?:\s+in)?\s+(?:[A-Za-z]+\s+\d{1,2},?\s+)?(?:19|20)\d{2}\b/gi,
      "age",
    ),
    ...collect(text, /\bclass\s+of\s+(?:19|20)\d{2}\b/gi, "age"),
    ...schoolSpans(text),
    ...collect(text, /\b(?:Mrs?|Ms|Mx)\.\s+[A-Z][a-z]+\b/g, "gender"),
    ...collect(text, /\bMiss\s+[A-Z][a-z]+\b/g, "gender"),
    ...collect(
      text,
      /\b(?:father|mother|mom|dad)\s+of\s+[a-z0-9]+(?:\s+[a-z0-9]+){0,3}/gi,
      "gender",
    ),
    ...collect(text, GENDER_RE, "gender"),
    ...nameSpans(text, name),
  ];

  const ranked = [...spans].sort((a, b) => {
    const priority = PRIORITY[b.kind] - PRIORITY[a.kind];
    if (priority !== 0) return priority;
    return b.end - b.start - (a.end - a.start);
  });
  const accepted: Span[] = [];
  for (const span of ranked) {
    if (span.end <= span.start) continue;
    const overlaps = accepted.some((kept) => span.start < kept.end && span.end > kept.start);
    if (!overlaps) accepted.push(span);
  }
  accepted.sort((a, b) => a.start - b.start);

  let cursor = 0;
  let output = "";
  const redactions: Redaction[] = [];
  for (const span of accepted) {
    output += text.slice(cursor, span.start);
    const replacement = TOKEN[span.kind];
    output += replacement;
    redactions.push({
      kind: span.kind,
      original: text.slice(span.start, span.end),
      replacement,
    });
    cursor = span.end;
  }
  output += text.slice(cursor);
  return { text: output, redactions, name };
}
