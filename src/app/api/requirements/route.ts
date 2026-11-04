import { errorResponse, readJson, rejectClientSecrets } from "@/lib/http";
import { resolveModel, resolveRunMode, ScreeningError } from "@/lib/config";
import { resolveRequirements } from "@/lib/screening/samples";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    rejectClientSecrets(body);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const jobText = String(record.jobText ?? "");
    if (!jobText.trim()) throw new ScreeningError("Paste a job description first.");
    if (jobText.length > 40_000) throw new ScreeningError("That job description is too long.");
    const requested = record.mode === "mock" || record.mode === "live" || record.mode === "auto" ? record.mode : "auto";
    const mode = resolveRunMode(requested);
    const model = resolveModel(typeof record.model === "string" ? record.model : undefined);
    if (mode === "live") {
      const llm = await import("@/lib/screening/llm");
      const requirements = await llm.llmExtractRequirements(jobText, model);
      const title = jobText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Untitled role";
      return Response.json({ requirements, source: "model", mode, model, jobTitle: title.slice(0, 160) });
    }
    const resolved = resolveRequirements(jobText);
    return Response.json({
      requirements: resolved.requirements,
      source: resolved.source,
      mode: "mock",
      model: "deterministic-mock",
      jobTitle: resolved.jobTitle,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
