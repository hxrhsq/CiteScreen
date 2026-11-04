import OpenAI from "openai";
import { inferenceConfig, resolveModel, scrubSecrets, ScreeningError } from "../config";
import { coerceModelRequirements } from "./extract";
import type { Requirement } from "./types";

export function parseModelJson(content: string): unknown {
  const stripped = content.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new ScreeningError("The model did not return JSON.", 502);
  }
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    throw new ScreeningError("The model returned JSON that could not be parsed.", 502);
  }
}

function client(): OpenAI {
  const cfg = inferenceConfig();
  if (!cfg.apiKey) {
    throw new ScreeningError("VULTR_API_KEY is not set.", 400);
  }
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    timeout: 60_000,
    maxRetries: 0,
  });
}

async function complete(model: string, system: string, user: string): Promise<string> {
  try {
    const response = await client().chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new ScreeningError("The model returned an empty response.", 502);
    return content;
  } catch (error) {
    if (error instanceof ScreeningError) throw error;
    const message = error instanceof Error ? error.message : "Vultr inference request failed.";
    throw new ScreeningError(scrubSecrets(message), 502);
  }
}

const EXTRACT_SYSTEM = `You extract hiring requirements for an evidence-based resume screener.
Return JSON only, with this shape:
{"requirements":[{"id":"req-1","category":"must_have"|"nice_to_have"|"responsibility","text":"short requirement copied from the job description","keywords":["lowercase signals a resume could quote"],"minMatches":1,"minYears":null,"weight":3}]}
Rules:
- Use only requirements written in the job description. Do not invent credentials, tools, or years.
- must_have = required qualifications. nice_to_have = preferred. responsibility = duties.
- keywords are concrete skills, tools, or credentials. 1 to 6 items. Lower case.
- minYears is an integer when the text says N+ years, otherwise null.
- weight is 3 for must_have, 2 for responsibility, 1 for nice_to_have.
- minMatches is how many of the keywords must appear for full support. Use 1 when a single keyword proves it.`;

const QUOTE_SYSTEM = `You copy evidence from a resume. You do not score the person and you do not infer.
For every requirement id, return 0 to 3 exact substrings copied from the resume.
If the resume does not say it, return an empty array. Never paraphrase. Never add words that are not in the resume.
Ignore name, age, gender, photos, and school prestige. Those are not evidence.
Return JSON only:
{"items":[{"id":"req-1","quotes":["exact substring from the resume"]}]}`;

export async function llmExtractRequirements(jobText: string, modelOverride?: string): Promise<Requirement[]> {
  const model = resolveModel(modelOverride);
  const content = await complete(
    model,
    EXTRACT_SYSTEM,
    `Job description:\n${jobText.slice(0, 20_000)}`,
  );
  const requirements = coerceModelRequirements(parseModelJson(content));
  if (requirements.length === 0) {
    throw new ScreeningError("The model did not return any usable requirements.", 502);
  }
  return requirements;
}

export async function llmProposeQuotes(input: {
  resume: string;
  requirements: Requirement[];
  model?: string;
}): Promise<Record<string, string[]>> {
  const model = resolveModel(input.model);
  const catalog = input.requirements.map((requirement) => ({
    id: requirement.id,
    text: requirement.text,
  }));
  const content = await complete(
    model,
    QUOTE_SYSTEM,
    `Requirements:\n${JSON.stringify(catalog)}\n\nResume:\n${input.resume.slice(0, 20_000)}`,
  );
  const parsed = parseModelJson(content);
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const items = Array.isArray(record.items) ? record.items : [];
  const quotes: Record<string, string[]> = {};
  for (const requirement of input.requirements) quotes[requirement.id] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? "");
    if (!quotes[id]) continue;
    const list = Array.isArray(row.quotes) ? row.quotes : [];
    quotes[id] = list.map((quote) => String(quote)).filter((quote) => quote.trim().length > 0).slice(0, 3);
  }
  return quotes;
}
