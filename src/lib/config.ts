import type { RequestedMode, RunMode } from "./screening/types";

/**
 * Chat model ids checked against the public Vultr Serverless Inference catalog
 * on 2026-11-02: https://api.vultrinference.com/docs/models
 *
 * `deepseek-v4.1-flash-1017` is the documented default when a chat request
 * omits `model` or sends an unknown id.
 */
export const DEFAULT_MODEL = "deepseek-v4.1-flash-1017";

export const DEFAULT_BASE_URL = "https://api.vultrinference.com/v1";

export const DEFAULT_FAIRNESS_THRESHOLD = 8;

export const VERIFIED_CHAT_MODELS = [
  "deepseek-v4.1-flash-1017",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "minimax-m3.1-flash",
  "muse-glimmer-30b",
  "nemotron-3-nano-omni-30b-a3b-reasoning",
  "nemotron-3.5-content-safety",
  "qwen3.8-27b",
  "qwen3.8-flash-next",
  "raon-1-mini-preview",
] as const;

export type InferenceConfig = {
  apiKey: string;
  model: string;
  baseURL: string;
  threshold: number;
  modeEnv: string;
  liveAvailable: boolean;
};

export function inferenceConfig(): InferenceConfig {
  const apiKey = (
    process.env.VULTR_API_KEY ||
    process.env.VULTR_INFERENCE_API_KEY ||
    ""
  ).trim();
  const model = (process.env.VULTR_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const baseURL = (process.env.VULTR_BASE_URL || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const parsedThreshold = Number(process.env.FAIRNESS_SHIFT_THRESHOLD ?? DEFAULT_FAIRNESS_THRESHOLD);
  const threshold =
    Number.isFinite(parsedThreshold) && parsedThreshold >= 0
      ? parsedThreshold
      : DEFAULT_FAIRNESS_THRESHOLD;
  const modeEnv = (process.env.SCREENING_MODE || "auto").trim().toLowerCase();
  return {
    apiKey,
    model,
    baseURL,
    threshold,
    modeEnv,
    liveAvailable: apiKey.length > 0,
  };
}

export class ScreeningError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ScreeningError";
    this.status = status;
  }
}

export function resolveRunMode(requested?: RequestedMode): RunMode {
  const cfg = inferenceConfig();
  const ask = requested ?? "auto";
  if (ask === "mock") return "mock";
  if (ask === "live") {
    if (!cfg.liveAvailable) {
      throw new ScreeningError(
        "VULTR_API_KEY is not set. Use mock mode, or add the key to the server environment. The browser never sends a key.",
        400,
      );
    }
    return "live";
  }
  if (cfg.modeEnv === "mock") return "mock";
  if (cfg.modeEnv === "live") {
    if (!cfg.liveAvailable) {
      throw new ScreeningError(
        "SCREENING_MODE=live but neither VULTR_API_KEY nor VULTR_INFERENCE_API_KEY is set.",
        400,
      );
    }
    return "live";
  }
  return cfg.liveAvailable ? "live" : "mock";
}

export function resolveModel(override?: string): string {
  const cfg = inferenceConfig();
  if (override && /^[a-zA-Z0-9._:-]{1,80}$/.test(override)) return override;
  return cfg.model;
}

export function scrubSecrets(message: string): string {
  const cfg = inferenceConfig();
  if (!cfg.apiKey) return message;
  return message.split(cfg.apiKey).join("[redacted]");
}

export function modelIsVerified(model: string): boolean {
  return (VERIFIED_CHAT_MODELS as readonly string[]).includes(model);
}
