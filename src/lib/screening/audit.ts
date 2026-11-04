import type { AuditEvent } from "./types";

export const AUDIT_COLUMNS = [
  "id",
  "at",
  "jobTitle",
  "candidateId",
  "candidateName",
  "mode",
  "model",
  "systemRecommendation",
  "systemScore",
  "decision",
  "override",
  "note",
  "blindScore",
  "blindDelta",
  "fairnessFlag",
] as const;

export type AuditExport = {
  exportedAt: string;
  product: "CiteScreen";
  jobTitle: string;
  mode: string;
  model: string;
  events: AuditEvent[];
};

export function toAuditJson(payload: Omit<AuditExport, "product"> & { product?: "CiteScreen" }): string {
  const body: AuditExport = { product: "CiteScreen", ...payload };
  return JSON.stringify(body, null, 2);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toAuditCsv(events: AuditEvent[]): string {
  const header = AUDIT_COLUMNS.join(",");
  const rows = events.map((event) => AUDIT_COLUMNS.map((column) => csvCell(event[column])).join(","));
  return [header, ...rows].join("\n");
}

export function latestDecision(events: AuditEvent[], candidateId: string): AuditEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.candidateId === candidateId) return events[index];
  }
  return undefined;
}
