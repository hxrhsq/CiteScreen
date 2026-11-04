import fs from "node:fs";
import path from "node:path";
import { heuristicExtract } from "./extract";
import { RUBRICS } from "./rubrics";
import type { Requirement, RequirementSource } from "./types";
import { normalizeNewlines } from "./text";

export type SampleJob = {
  id: string;
  title: string;
  company: string;
  text: string;
  requirements: Requirement[];
};

export type SampleResume = {
  id: string;
  name: string;
  text: string;
};

function dataRoot(): string {
  return path.join(process.cwd(), "data");
}

export function loadJobs(): SampleJob[] {
  return Object.keys(RUBRICS).map((id) => {
    const rubric = RUBRICS[id];
    const text = fs.readFileSync(path.join(dataRoot(), "jobs", `${id}.txt`), "utf8");
    return {
      id,
      title: rubric?.title ?? id,
      company: rubric?.company ?? "",
      text: text.replace(/\r\n/g, "\n").replace(/\s+$/, ""),
      requirements: rubric?.requirements ?? [],
    };
  });
}

export function loadResumes(): SampleResume[] {
  const dir = path.join(dataRoot(), "resumes");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .map((filename) => {
      const text = fs.readFileSync(path.join(dir, filename), "utf8").replace(/\r\n/g, "\n").replace(/\s+$/, "");
      const name = text.split("\n").map((line) => line.trim()).find(Boolean) ?? filename;
      return { id: filename.replace(/\.txt$/, ""), name, text };
    });
}

export function resolveRequirements(jobText: string): {
  requirements: Requirement[];
  source: Extract<RequirementSource, "curated" | "heuristic">;
  jobTitle: string;
} {
  const normalized = normalizeNewlines(jobText);
  const curated = loadJobs().find((job) => normalizeNewlines(job.text) === normalized);
  if (curated) {
    return { requirements: curated.requirements, source: "curated", jobTitle: curated.title };
  }
  const requirements = heuristicExtract(jobText);
  const first = jobText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Untitled role";
  return { requirements, source: "heuristic", jobTitle: first.slice(0, 120) };
}
