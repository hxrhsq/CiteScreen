import { ScreeningError, scrubSecrets } from "./config";
import { ParseError } from "./parsing/extract-file";
import { sanitizeRequirements } from "./screening/extract";
import type { RequestedMode, ScreenInput } from "./screening/types";

export function errorResponse(error: unknown): Response {
  if (error instanceof ScreeningError || error instanceof ParseError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return Response.json({ error: scrubSecrets(message) }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ScreeningError("The request body has to be JSON.");
  }
}

export function rejectClientSecrets(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const record = body as Record<string, unknown>;
  if ("apiKey" in record || "api_key" in record || "VULTR_API_KEY" in record || "authorization" in record) {
    throw new ScreeningError("Do not send an API key from the browser. Set VULTR_API_KEY on the server.");
  }
}

function asMode(value: unknown): RequestedMode {
  if (value === "mock" || value === "live" || value === "auto") return value;
  return "auto";
}

export function asScreenInput(body: unknown): ScreenInput {
  rejectClientSecrets(body);
  if (!body || typeof body !== "object") throw new ScreeningError("Invalid request.");
  const record = body as Record<string, unknown>;
  const jobText = String(record.jobText ?? "");
  if (jobText.length > 40_000) throw new ScreeningError("That job description is too long.");
  const candidatesRaw = Array.isArray(record.candidates) ? record.candidates : [];
  const candidates = candidatesRaw.map((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const text = String(row.text ?? "");
    if (text.length > 50_000) throw new ScreeningError(`Resume ${index + 1} is too long.`);
    return {
      id: String(row.id ?? `candidate-${index + 1}`).slice(0, 80),
      name: row.name ? String(row.name).slice(0, 80) : undefined,
      text,
    };
  });
  const provided = Array.isArray(record.requirements) ? sanitizeRequirements(record.requirements) : undefined;
  if (Array.isArray(record.requirements) && record.requirements.length > 0 && (!provided || provided.length === 0)) {
    throw new ScreeningError("Those requirements could not be read.");
  }
  const requirements = provided && provided.length > 0 ? provided : undefined;
  return {
    jobText,
    jobTitle: typeof record.jobTitle === "string" ? record.jobTitle.slice(0, 160) : undefined,
    candidates,
    requirements,
    mode: asMode(record.mode),
    model: typeof record.model === "string" ? record.model : undefined,
  };
}
