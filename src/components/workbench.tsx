"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { latestDecision, toAuditCsv, toAuditJson } from "@/lib/screening/audit";
import { deriveRequirement, weightFor } from "@/lib/screening/extract";
import type {
  AuditEvent,
  Category,
  Recommendation,
  Redaction,
  Requirement,
  RequirementResult,
  RequirementSource,
  RequestedMode,
  ScreenReport,
} from "@/lib/screening/types";

type DraftCandidate = { id: string; name: string; text: string; filename?: string };
type SampleJob = { id: string; title: string; company: string; text: string };
type SampleResume = { id: string; name: string; text: string };
type TabId = "shortlist" | "review" | "fairness" | "audit";
type Health = {
  mode: "mock" | "live";
  autoError: string | null;
  liveAvailable: boolean;
  model: string;
  modelVerified: boolean;
  baseUrl: string;
  threshold: number;
  verifiedModels: string[];
};

const REC_LABEL: Record<Recommendation, string> = {
  advance: "Advance",
  hold: "Hold",
  decline: "Do not advance",
};

const STATUS_LABEL = {
  supported: "Supported",
  partial: "Partial",
  no_evidence: "No evidence",
} as const;

const CATEGORY_LABEL: Record<Category, string> = {
  must_have: "Must have",
  nice_to_have: "Nice to have",
  responsibility: "Responsibility",
};

const SOURCE_LABEL: Record<RequirementSource, string> = {
  curated: "Sample rubric, matched to this job text",
  heuristic: "Read from the bullets in the job text",
  provided: "The rubric you confirmed",
  model: "Proposed by the model, then checked here",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data as T;
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toneClass(recommendation: Recommendation): string {
  if (recommendation === "advance") return "tone-advance";
  if (recommendation === "hold") return "tone-hold";
  return "tone-decline";
}

function CitedResume({
  text,
  results,
  activeId,
}: {
  text: string;
  results: RequirementResult[];
  activeId: string | null;
}) {
  const snippets = results
    .flatMap((result) =>
      result.snippets.map((snippet) => ({ ...snippet, requirementId: result.requirementId })),
    )
    .filter((snippet) => (activeId ? snippet.requirementId === activeId : true))
    .sort((a, b) => a.start - b.start);
  const parts: { key: string; text: string; mark?: boolean; id?: string }[] = [];
  let cursor = 0;
  snippets.forEach((snippet, index) => {
    if (snippet.start < cursor || snippet.end <= snippet.start) return;
    if (snippet.start > cursor) {
      parts.push({ key: `t-${cursor}`, text: text.slice(cursor, snippet.start) });
    }
    parts.push({
      key: `m-${snippet.start}-${index}`,
      text: text.slice(snippet.start, snippet.end),
      mark: true,
      id: snippet.requirementId,
    });
    cursor = snippet.end;
  });
  if (cursor < text.length) parts.push({ key: `t-${cursor}`, text: text.slice(cursor) });

  return (
    <pre className="font-mono text-[13px] leading-6 whitespace-pre-wrap text-foreground">
      {parts.map((part) =>
        part.mark ? (
          <mark key={part.key} id={part.id ? `snip-${part.id}` : undefined} className="evidence-mark">
            {part.text}
          </mark>
        ) : (
          <span key={part.key}>{part.text}</span>
        ),
      )}
    </pre>
  );
}

function RedactedBody({ text }: { text: string }) {
  const parts = text.split(/(\[(?:NAME|GENDER|PHOTO|SCHOOL|AGE|CONTACT)\])/g);
  return (
    <pre className="font-mono text-[13px] leading-6 whitespace-pre-wrap">
      {parts.map((part, index) =>
        part.startsWith("[") && part.endsWith("]") ? (
          <mark key={`${part}-${index}`} className="token-mark">
            {part}
          </mark>
        ) : (
          <span key={`${index}-${part.slice(0, 12)}`}>{part}</span>
        ),
      )}
    </pre>
  );
}

function kindCounts(redactions: Redaction[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of redactions) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return [...counts.entries()];
}

export function Workbench() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [library, setLibrary] = useState<{ jobs: SampleJob[]; resumes: SampleResume[] } | null>(null);
  const [mode, setMode] = useState<RequestedMode>("auto");
  const [model, setModel] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobCompany, setJobCompany] = useState("");
  const [jobText, setJobText] = useState("");
  const [candidates, setCandidates] = useState<DraftCandidate[]>([]);
  const [requirements, setRequirements] = useState<Requirement[] | null>(null);
  const [rubricSource, setRubricSource] = useState<RequirementSource | null>(null);
  const [rubricEdited, setRubricEdited] = useState(false);
  const [report, setReport] = useState<ScreenReport | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeReq, setActiveReq] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<AuditEvent[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<TabId>("shortlist");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteName, setPasteName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [maskNames, setMaskNames] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [healthResponse, sampleResponse] = await Promise.all([
          fetch("/api/health"),
          fetch("/api/samples"),
        ]);
        if (!healthResponse.ok || !sampleResponse.ok) throw new Error("The workbench could not load its sample packet.");
        const healthBody = (await healthResponse.json()) as Health;
        const sampleBody = (await sampleResponse.json()) as { jobs: SampleJob[]; resumes: SampleResume[] };
        if (cancelled) return;
        setHealth(healthBody);
        setModel(healthBody.model);
        setLibrary(sampleBody);
      } catch (loadError) {
        if (!cancelled) setError(messageOf(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = report?.ranked.find((item) => item.candidateId === selectedId) ?? null;
  const decidedCount = useMemo(() => {
    const ids = new Set(decisions.map((event) => event.candidateId));
    return ids.size;
  }, [decisions]);

  function invalidateScore(message: string) {
    if (report) {
      setReport(null);
      setDecisions([]);
      setNotice(message);
    }
    setRubricEdited(true);
  }

  async function readJob(text: string, title = jobTitle) {
    setBusy("Reading the job description…");
    setError(null);
    try {
      const body = await postJson<{
        requirements: Requirement[];
        source: RequirementSource;
        jobTitle: string;
      }>("/api/requirements", { jobText: text, jobTitle: title, mode, model });
      setRequirements(body.requirements);
      setRubricSource(body.source);
      setRubricEdited(false);
      if (!jobTitle) setJobTitle(body.jobTitle);
      setReport(null);
      setTab("shortlist");
    } catch (readError) {
      setError(messageOf(readError));
    } finally {
      setBusy(null);
    }
  }

  async function loadPacket(jobId: string) {
    setError(null);
    setNotice(null);
    if (!library) {
      setError("Sample resumes are still loading.");
      return;
    }
    const job = library.jobs.find((item) => item.id === jobId);
    if (!job) return;
    setJobTitle(job.title);
    setJobCompany(job.company);
    setJobText(job.text);
    setCandidates(library.resumes.map((resume) => ({ id: resume.id, name: resume.name, text: resume.text })));
    setDecisions([]);
    setNotes({});
    setSelectedId(null);
    setReport(null);
    setRequirements(null);
    setBusy("Reading the job description…");
    try {
      const body = await postJson<{
        requirements: Requirement[];
        source: RequirementSource;
        jobTitle: string;
      }>("/api/requirements", { jobText: job.text, jobTitle: job.title, mode, model });
      setRequirements(body.requirements);
      setRubricSource(body.source);
      setRubricEdited(false);
      setTab("shortlist");
    } catch (readError) {
      setError(messageOf(readError));
    } finally {
      setBusy(null);
    }
  }

  async function score() {
    if (!jobText.trim()) {
      setError("Paste a job description or load a sample packet.");
      return;
    }
    if (candidates.length === 0) {
      setError("Add at least one resume.");
      return;
    }
    if (!requirements || requirements.length === 0) {
      setError("Read the job description before scoring, so you can see the rubric.");
      return;
    }
    setBusy(`Scoring ${candidates.length} resume${candidates.length === 1 ? "" : "s"} against ${requirements.length} requirements…`);
    setError(null);
    setNotice(null);
    try {
      const body = await postJson<ScreenReport>("/api/screen", {
        jobText,
        jobTitle,
        mode,
        model,
        requirements,
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          text: candidate.text,
        })),
      });
      setReport(body);
      setSelectedId(body.ranked[0]?.candidateId ?? null);
      setActiveReq(null);
      setDecisions([]);
      setTab("shortlist");
    } catch (scoreError) {
      setError(messageOf(scoreError));
    } finally {
      setBusy(null);
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files];
    if (list.length === 0) return;
    setBusy("Extracting resume text…");
    setError(null);
    try {
      const added: DraftCandidate[] = [];
      for (const file of list) {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/parse", { method: "POST", body: form });
        const data = (await response.json().catch(() => ({}))) as { error?: string; name?: string; text?: string; filename?: string };
        if (!response.ok || !data.text) throw new Error(data.error || `Could not read ${file.name}.`);
        added.push({
          id: `upload-${crypto.randomUUID().slice(0, 8)}`,
          name: data.name || file.name,
          text: data.text,
          filename: data.filename || file.name,
        });
      }
      setCandidates((current) => [...current, ...added].slice(0, 8));
      setReport(null);
      setNotice("Resume text extracted. Read the job, then score.");
    } catch (uploadError) {
      setError(messageOf(uploadError));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function addPasted() {
    const text = pasteText.trim();
    if (text.length < 20) {
      setError("Paste a fuller resume. A line or two is not enough to cite.");
      return;
    }
    const first = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "Pasted resume";
    setCandidates((current) => [
      ...current,
      { id: `paste-${crypto.randomUUID().slice(0, 8)}`, name: pasteName.trim() || first.slice(0, 80), text },
    ].slice(0, 8));
    setPasteOpen(false);
    setPasteName("");
    setPasteText("");
    setReport(null);
  }

  function recordDecision(decision: Recommendation) {
    if (!report || !selected) return;
    const note = (notes[selected.candidateId] ?? "").trim();
    const override = decision !== selected.result.recommendation;
    if (override && note.length < 8) {
      setError("Add a note of at least 8 characters when you override the recommendation.");
      return;
    }
    const event: AuditEvent = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      jobTitle: report.jobTitle,
      candidateId: selected.candidateId,
      candidateName: selected.name,
      mode: report.mode,
      model: report.model,
      systemRecommendation: selected.result.recommendation,
      systemScore: selected.result.overall,
      decision,
      override,
      note,
      blindScore: selected.blind.result.overall,
      blindDelta: selected.blind.delta,
      fairnessFlag: selected.blind.flagged,
    };
    setDecisions((current) => [...current, event]);
    setError(null);
    setNotice(override ? "Override recorded in the audit trail." : "Confirmation recorded in the audit trail.");
    setTab("audit");
  }

  function exportAudit(kind: "json" | "csv") {
    if (!report || decisions.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === "json") {
      download(
        `citescreen-audit-${stamp}.json`,
        toAuditJson({
          exportedAt: new Date().toISOString(),
          jobTitle: report.jobTitle,
          mode: report.mode,
          model: report.model,
          events: decisions,
        }),
        "application/json",
      );
      return;
    }
    download(`citescreen-audit-${stamp}.csv`, toAuditCsv(decisions), "text/csv");
  }

  const flagged = report?.ranked.filter((item) => item.blind.flagged).length ?? 0;
  const displayName = (name: string, rank: number) => (maskNames ? `Candidate ${rank}` : name);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-primary text-primary-foreground">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <p className="font-heading text-2xl leading-none tracking-tight">CiteScreen</p>
            <p className="mt-1 text-xs text-primary-foreground/75">
              Evidence desk for recruiters · lablab.ai Agent Rush
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-primary-foreground/10 px-3 py-1">
              {report
                ? report.mode === "mock"
                  ? "Scored with the deterministic mock"
                  : `Scored live · ${report.model}`
                : health?.mode === "live"
                  ? `Auto will call ${health.model}`
                  : "Deterministic mock · no API key"}
            </span>
            {report ? (
              <span className="rounded-full bg-primary-foreground/10 px-3 py-1">
                {decidedCount} of {report.ranked.length} decisions recorded
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1400px] lg:h-[calc(100dvh-4.25rem)] lg:grid-cols-[22.5rem_1fr]">
        <aside className="border-b border-border bg-card lg:overflow-auto lg:border-r lg:border-b-0">
          <div className="space-y-5 p-4 sm:p-5">
            <div>
              <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Sample packets</p>
              <div className="mt-2 grid gap-2">
                {(library?.jobs ?? [
                  { id: "platform-engineer", title: "Senior Backend Engineer", company: "Northwind Ledger", text: "" },
                  { id: "people-partner", title: "People Operations Partner", company: "Harbor & Pine", text: "" },
                ]).map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => void loadPacket(job.id)}
                    disabled={!library || Boolean(busy)}
                    className="rounded-xl border border-border bg-background px-3 py-3 text-left transition hover:border-primary/40 disabled:opacity-50"
                  >
                    <span className="block text-sm font-medium">{job.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {job.company} · 6 synthetic resumes
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label htmlFor="mode">Scoring mode</Label>
              <select
                id="mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as RequestedMode)}
                className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
              >
                <option value="auto">Auto · mock unless a server key is set</option>
                <option value="mock">Deterministic mock</option>
                <option value="live" disabled={!health?.liveAvailable}>
                  Vultr live{health?.liveAvailable ? "" : " · no key on this server"}
                </option>
              </select>
              <Label htmlFor="model" className="text-muted-foreground">
                Model id
              </Label>
              <Input
                id="model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                spellCheck={false}
                placeholder="deepseek-v4.1-flash-1017"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Default verified id is deepseek-v4.1-flash-1017. The key stays in VULTR_API_KEY on the server.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="job">Job description</Label>
              <Input
                value={jobTitle}
                onChange={(event) => setJobTitle(event.target.value)}
                placeholder="Role title"
                aria-label="Role title"
              />
              <Textarea
                id="job"
                value={jobText}
                onChange={(event) => {
                  setJobText(event.target.value);
                  setRequirements(null);
                  setReport(null);
                }}
                placeholder="Paste a job description. Bullets under Requirements and Preferred are picked up automatically."
                className="min-h-40"
                style={{ minHeight: "11rem" }}
              />
              <Button type="button" variant="outline" onClick={() => void readJob(jobText)} disabled={Boolean(busy) || !jobText.trim()}>
                Read the job
              </Button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Resumes</Label>
                <span className="text-xs text-muted-foreground">{candidates.length} / 8</span>
              </div>
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  void uploadFiles(event.dataTransfer.files);
                }}
                className={`rounded-xl border border-dashed px-3 py-3 ${dragging ? "border-primary bg-primary/5" : "border-border"}`}
              >
                <p className="text-xs leading-5 text-muted-foreground">
                  Drop PDF, DOCX, or TXT here, or paste text. Uploads are read in memory and not stored.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
                    Upload
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setPasteOpen(true)}>
                    Paste
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.docx,.txt,.md,.text,application/pdf,text/plain"
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      if (event.target.files) void uploadFiles(event.target.files);
                    }}
                  />
                </div>
              </div>
              <ul className="space-y-1.5">
                {candidates.map((candidate) => (
                  <li key={candidate.id} className="flex items-start justify-between gap-2 rounded-lg bg-background px-2.5 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{candidate.name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {candidate.filename ?? `${candidate.text.length.toLocaleString()} characters`}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => {
                        setCandidates((current) => current.filter((item) => item.id !== candidate.id));
                        setReport(null);
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
                {candidates.length === 0 ? (
                  <li className="text-xs text-muted-foreground">No resumes yet.</li>
                ) : null}
              </ul>
            </div>

            <Button type="button" className="h-10 w-full" onClick={() => void score()} disabled={Boolean(busy)}>
              {busy ? "Working…" : "Score on evidence"}
            </Button>
            <p className="text-xs leading-5 text-muted-foreground">
              A line is cited or the requirement stays at no evidence. Date ranges are not converted into years. You confirm or override every recommendation.
            </p>
          </div>
        </aside>

        <main className="min-w-0 lg:overflow-auto">
          <div className="space-y-4 p-4 sm:p-6">
            {error ? (
              <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <p>{error}</p>
                <button type="button" className="text-xs underline" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </div>
            ) : null}
            {notice ? (
              <div className="flex items-start justify-between gap-3 rounded-xl bg-secondary px-3 py-2 text-sm">
                <p>{notice}</p>
                <button type="button" className="text-xs underline" onClick={() => setNotice(null)}>
                  Dismiss
                </button>
              </div>
            ) : null}
            {busy ? (
              <p aria-live="polite" className="text-sm text-muted-foreground">
                {busy}
              </p>
            ) : null}

            {!jobText && candidates.length === 0 ? (
              <section className="rounded-2xl border border-border bg-card px-5 py-8 sm:px-8">
                <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
                  Powering the future of work
                </p>
                <h1 className="mt-2 max-w-xl font-heading text-4xl leading-tight tracking-tight">
                  If it is not written down, it is not a point.
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
                  CiteScreen reads a job and the resumes in front of you. It scores only verbatim lines, leaves a gap when a resume is silent, asks you to confirm or override, and re-scores a copy with names, schools, ages, photos, and gender cues removed.
                </p>
                <div className="mt-6 flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void loadPacket("platform-engineer")} disabled={!library || Boolean(busy)}>
                    Load the payments packet
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void loadPacket("people-partner")} disabled={!library || Boolean(busy)}>
                    Load the people-ops packet
                  </Button>
                </div>
              </section>
            ) : null}

            <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)}>
              <TabsList className="h-auto flex-wrap">
                <TabsTrigger value="shortlist">Shortlist</TabsTrigger>
                <TabsTrigger value="review">Evidence</TabsTrigger>
                <TabsTrigger value="fairness">Blind review</TabsTrigger>
                <TabsTrigger value="audit">Audit trail</TabsTrigger>
              </TabsList>

              <TabsContent value="shortlist" className="mt-4 space-y-4">
                <Rubric
                  requirements={requirements}
                  source={rubricSource}
                  edited={rubricEdited}
                  onChange={(next, note) => {
                    setRequirements(next);
                    invalidateScore(note);
                  }}
                />
                {report ? (
                  <section className="space-y-3">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                      <div>
                        <h2 className="font-heading text-2xl tracking-tight">
                          {report.jobTitle}
                          {jobCompany ? <span className="text-muted-foreground"> · {jobCompany}</span> : null}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                          {report.ranked.length} candidates · {report.elapsedMs} ms · {SOURCE_LABEL[report.requirementSource]}
                          {flagged > 0 ? ` · ${flagged} fairness flag${flagged === 1 ? "" : "s"}` : " · no fairness flags"}
                        </p>
                      </div>
                    </div>
                    <ol className="space-y-2">
                      {report.ranked.map((item) => {
                        const latest = latestDecision(decisions, item.candidateId);
                        return (
                          <li key={item.candidateId}>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedId(item.candidateId);
                                setActiveReq(item.result.requirementResults.find((row) => row.status === "no_evidence")?.requirementId ?? item.result.requirementResults[0]?.requirementId ?? null);
                                setTab("review");
                              }}
                              className={`grid w-full gap-3 rounded-2xl border bg-card px-4 py-3 text-left sm:grid-cols-[auto_1fr_auto] ${selectedId === item.candidateId ? "border-primary" : "border-border"}`}
                            >
                              <span className="font-heading text-2xl text-muted-foreground">{item.rank}</span>
                              <span>
                                <span className="block text-base font-medium">{item.name}</span>
                                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.result.explanation}</span>
                              </span>
                              <span className="flex flex-wrap items-center gap-2 sm:justify-end">
                                <span className="font-heading text-2xl tabular-nums">{item.result.overall}</span>
                                <span className={`rounded-full px-2.5 py-1 text-xs ${toneClass(item.result.recommendation)}`}>
                                  {REC_LABEL[item.result.recommendation]}
                                </span>
                                {item.result.mustHaveGaps > 0 ? (
                                  <Badge variant="outline">{item.result.mustHaveGaps} must-have gaps</Badge>
                                ) : null}
                                {item.blind.flagged ? <Badge variant="destructive">Fairness flag</Badge> : null}
                                {latest ? (
                                  <Badge variant="secondary">{latest.override ? "Overridden" : "Confirmed"}</Badge>
                                ) : (
                                  <Badge variant="outline">Decision pending</Badge>
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                ) : requirements && requirements.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    The rubric is ready. Score when you are willing to stand behind these requirements.
                  </p>
                ) : null}
              </TabsContent>

              <TabsContent value="review" className="mt-4">
                {selected && report ? (
                  <Review
                    name={selected.name}
                    text={candidates.find((candidate) => candidate.id === selected.candidateId)?.text ?? ""}
                    requirements={report.requirements}
                    results={selected.result.requirementResults}
                    explanation={selected.result.explanation}
                    recommendation={selected.result.recommendation}
                    overall={selected.result.overall}
                    activeReq={activeReq}
                    note={notes[selected.candidateId] ?? ""}
                    latest={latestDecision(decisions, selected.candidateId)}
                    onSelectReq={(id) => {
                      setActiveReq(id);
                      requestAnimationFrame(() => {
                        document.getElementById(`snip-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
                      });
                    }}
                    onNote={(value) => setNotes((current) => ({ ...current, [selected.candidateId]: value }))}
                    onDecide={recordDecision}
                  />
                ) : (
                  <EmptyCopy title="No resume is open" body="Score a packet, then open a candidate to read the cited lines beside the source." />
                )}
              </TabsContent>

              <TabsContent value="fairness" className="mt-4 space-y-4">
                {report ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h2 className="font-heading text-2xl tracking-tight">Blind review</h2>
                        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                          The same rubric was run again after names, gender cues, photos, school names, ages, and contact identifiers were removed. A flag means the overall score moved by {report.threshold}+ points, or a requirement lost every citation.
                        </p>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => setMaskNames((value) => !value)}>
                        {maskNames ? "Show names" : "Mask names"}
                      </Button>
                    </div>
                    <div className="overflow-x-auto rounded-2xl border border-border bg-card">
                      <table className="w-full min-w-[640px] text-left text-sm">
                        <thead className="text-xs text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-medium">Candidate</th>
                            <th className="px-3 py-2 font-medium">Original</th>
                            <th className="px-3 py-2 font-medium">Blind</th>
                            <th className="px-3 py-2 font-medium">Delta</th>
                            <th className="px-3 py-2 font-medium">Flag</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.ranked.map((item) => (
                            <tr key={item.candidateId} className="border-t border-border">
                              <td className="px-3 py-2">
                                <button type="button" className="underline-offset-2 hover:underline" onClick={() => setSelectedId(item.candidateId)}>
                                  {displayName(item.name, item.rank)}
                                </button>
                              </td>
                              <td className="px-3 py-2 tabular-nums">{item.result.overall}</td>
                              <td className="px-3 py-2 tabular-nums">{item.blind.result.overall}</td>
                              <td className="px-3 py-2 tabular-nums">{item.blind.delta > 0 ? `+${item.blind.delta}` : item.blind.delta}</td>
                              <td className="px-3 py-2">
                                <span className={`rounded-full px-2 py-0.5 text-xs ${item.blind.flagged ? "tone-flag" : "tone-clear"}`}>
                                  {item.blind.flagged ? "Flag" : "Stable"}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {selected ? (
                      <FairnessDetail
                        title={maskNames ? `Candidate ${selected.rank}` : selected.name}
                        reasons={selected.blind.reasons}
                        redactions={selected.blind.redactions}
                        redactedText={selected.blind.redactedText}
                        deltas={selected.blind.requirementDeltas}
                      />
                    ) : null}
                  </>
                ) : (
                  <EmptyCopy title="Blind review waits for a score" body="Load a packet and score it. The redacted pass is included, so this tab fills in immediately." />
                )}
              </TabsContent>

              <TabsContent value="audit" className="mt-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-heading text-2xl tracking-tight">Audit trail</h2>
                    <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                      Nothing here is final until you confirm or override it. Export keeps every event, oldest first, including the note and whether it differed from the evidence score.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={decisions.length === 0} onClick={() => exportAudit("csv")}>
                      Export CSV
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={decisions.length === 0} onClick={() => exportAudit("json")}>
                      Export JSON
                    </Button>
                  </div>
                </div>
                {decisions.length === 0 ? (
                  <EmptyCopy title="No decisions yet" body="Open a scored resume and confirm the recommendation, or override it with a note." />
                ) : (
                  <ol className="space-y-2">
                    {decisions.map((event) => (
                      <li key={event.id} className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{event.candidateName}</span>
                          <span className={`rounded-full px-2 py-0.5 text-xs ${toneClass(event.decision)}`}>{REC_LABEL[event.decision]}</span>
                          <Badge variant={event.override ? "destructive" : "secondary"}>
                            {event.override ? "Override" : "Confirmed"}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            system {REC_LABEL[event.systemRecommendation]} · {event.systemScore}
                            {event.fairnessFlag ? " · fairness flag" : ""}
                          </span>
                        </div>
                        {event.note ? <p className="mt-2 text-sm leading-6">{event.note}</p> : null}
                        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                          {event.at} · {event.mode} · {event.model}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </main>
      </div>

      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent style={{ maxWidth: "40rem" }} className="w-[calc(100%-2rem)]">
          <DialogHeader>
            <DialogTitle>Paste a resume</DialogTitle>
            <DialogDescription>Plain text only. The first line is used as the name when you leave the name blank.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="paste-name">Name</Label>
            <Input id="paste-name" value={pasteName} onChange={(event) => setPasteName(event.target.value)} placeholder="Optional" />
            <Label htmlFor="paste-text">Resume</Label>
            <Textarea id="paste-text" value={pasteText} onChange={(event) => setPasteText(event.target.value)} style={{ minHeight: "14rem" }} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPasteOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={addPasted}>
              Add resume
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyCopy({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border px-4 py-8">
      <h2 className="font-heading text-xl">{title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}

function Rubric({
  requirements,
  source,
  edited,
  onChange,
}: {
  requirements: Requirement[] | null;
  source: RequirementSource | null;
  edited: boolean;
  onChange: (next: Requirement[], note: string) => void;
}) {
  const [draft, setDraft] = useState("");
  if (!requirements) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
        Read a job description to see the requirements before anyone is scored.
      </div>
    );
  }
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">Requirements</h2>
        <p className="text-xs text-muted-foreground">{edited ? "Edited locally. Score again to apply." : source ? SOURCE_LABEL[source] : ""}</p>
      </div>
      <ul className="mt-3 space-y-3">
        {requirements.map((requirement) => (
          <li key={requirement.id} className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[9rem_1fr_auto]">
            <label className="text-xs text-muted-foreground">
              Category
              <select
                aria-label={`Category for ${requirement.text}`}
                value={requirement.category}
                className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                onChange={(event) => {
                  const category = event.target.value as Category;
                  onChange(
                    requirements.map((item) =>
                      item.id === requirement.id ? { ...item, category, weight: weightFor(category) } : item,
                    ),
                    "Category changed. Score again before recording decisions.",
                  );
                }}
              >
                {(Object.keys(CATEGORY_LABEL) as Category[]).map((category) => (
                  <option key={category} value={category}>
                    {CATEGORY_LABEL[category]}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <input
                defaultValue={requirement.text}
                key={`${requirement.id}-${requirement.text}`}
                aria-label="Requirement text"
                className="w-full bg-transparent text-sm outline-none"
                onBlur={(event) => {
                  const text = event.target.value.trim();
                  if (!text || text === requirement.text) return;
                  const next = deriveRequirement(text, requirement.category, requirement.id);
                  onChange(
                    requirements.map((item) => (item.id === requirement.id ? { ...next, id: requirement.id } : item)),
                    "Requirement text changed. Score again before recording decisions.",
                  );
                }}
              />
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                Looks for {requirement.keywords.join(", ") || "—"}
                {requirement.minYears ? ` · needs an explicit ${requirement.minYears}+ years` : ""}
                {requirement.weakKeywords.length ? " · university wording alone stays partial" : ""}
              </p>
            </div>
            <button
              type="button"
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() =>
                onChange(
                  requirements.filter((item) => item.id !== requirement.id),
                  "A requirement was removed. Score again before recording decisions.",
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (text.length < 3) return;
          onChange(
            [...requirements, deriveRequirement(text, "must_have", `custom-${requirements.length + 1}`)],
            "A requirement was added. Score again before recording decisions.",
          );
          setDraft("");
        }}
      >
        <Input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a requirement in your own words" aria-label="New requirement" />
        <Button type="submit" variant="outline">
          Add
        </Button>
      </form>
    </section>
  );
}

function Review({
  name,
  text,
  requirements,
  results,
  explanation,
  recommendation,
  overall,
  activeReq,
  note,
  latest,
  onSelectReq,
  onNote,
  onDecide,
}: {
  name: string;
  text: string;
  requirements: Requirement[];
  results: RequirementResult[];
  explanation: string;
  recommendation: Recommendation;
  overall: number;
  activeReq: string | null;
  note: string;
  latest?: AuditEvent;
  onSelectReq: (id: string) => void;
  onNote: (value: string) => void;
  onDecide: (decision: Recommendation) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="space-y-3">
        <div>
          <h2 className="font-heading text-3xl tracking-tight">{name}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{explanation}</p>
          <p className="mt-2 text-sm">
            Evidence score <span className="font-heading text-2xl tabular-nums">{overall}</span>
          </p>
        </div>
        <ul className="space-y-2">
          {requirements.map((requirement) => {
            const result = results.find((item) => item.requirementId === requirement.id);
            if (!result) return null;
            const open = activeReq === requirement.id;
            return (
              <li key={requirement.id}>
                <button
                  type="button"
                  onClick={() => onSelectReq(requirement.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left ${open ? "border-primary bg-card" : "border-border bg-card/60"}`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{CATEGORY_LABEL[requirement.category]}</Badge>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${result.status === "no_evidence" ? "tone-flag" : result.status === "partial" ? "tone-hold" : "tone-clear"}`}>
                      {STATUS_LABEL[result.status]}
                    </span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">{result.score}</span>
                  </span>
                  <span className="mt-1 block text-sm">{requirement.text}</span>
                  {open ? <span className="mt-2 block text-xs leading-5 text-muted-foreground">{result.rationale}</span> : null}
                  {open && result.snippets.length > 0 ? (
                    <span className="mt-2 block border-l-2 border-primary/40 pl-2 text-xs leading-5">
                      {result.snippets.map((snippet) => `“${snippet.text}”`).join(" ")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="rounded-2xl border border-border bg-card p-3">
          <Label htmlFor="decision-note">Decision note</Label>
          <Textarea
            id="decision-note"
            value={note}
            onChange={(event) => onNote(event.target.value)}
            placeholder="Required if you override. Optional if you confirm."
            className="mt-2"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {(["advance", "hold", "decline"] as Recommendation[]).map((decision) => (
              <Button
                key={decision}
                type="button"
                variant={decision === recommendation ? "default" : "outline"}
                onClick={() => onDecide(decision)}
              >
                {decision === recommendation ? `Confirm ${REC_LABEL[decision].toLowerCase()}` : REC_LABEL[decision]}
              </Button>
            ))}
          </div>
          {latest ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Latest record: {latest.override ? "override" : "confirmation"} to {REC_LABEL[latest.decision].toLowerCase()} at {latest.at}.
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">No decision recorded for this person yet.</p>
          )}
        </div>
      </section>
      <section className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Resume, with citations marked</h3>
        <div className="mt-3 max-h-[70vh] overflow-auto">
          <CitedResume text={text} results={results} activeId={activeReq} />
        </div>
      </section>
    </div>
  );
}

function FairnessDetail({
  title,
  reasons,
  redactions,
  redactedText,
  deltas,
}: {
  title: string;
  reasons: string[];
  redactions: Redaction[];
  redactedText: string;
  deltas: ScreenReport["ranked"][number]["blind"]["requirementDeltas"];
}) {
  const examples = new Map<string, string>();
  for (const item of redactions) {
    if (!examples.has(item.kind)) examples.set(item.kind, item.original);
  }
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <h3 className="font-heading text-xl">{title}</h3>
      {reasons.map((reason) => (
        <p key={reason} className="text-sm leading-6">
          {reason}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        {kindCounts(redactions).map(([kind, count]) => (
          <Badge key={kind} variant="outline">
            {kind} · {count}
            {examples.get(kind) ? ` · “${examples.get(kind)?.slice(0, 42)}”` : ""}
          </Badge>
        ))}
        {redactions.length === 0 ? <Badge variant="outline">Nothing redacted</Badge> : null}
      </div>
      <ul className="space-y-1 text-xs">
        {deltas
          .filter((item) => item.beforeScore !== item.afterScore || item.beforeStatus !== item.afterStatus)
          .map((item) => (
            <li key={item.requirementId}>
              {item.text}: {item.beforeStatus} {item.beforeScore} → {item.afterStatus} {item.afterScore}
            </li>
          ))}
      </ul>
      <div className="max-h-80 overflow-auto rounded-xl bg-background p-3">
        <RedactedBody text={redactedText} />
      </div>
    </section>
  );
}
