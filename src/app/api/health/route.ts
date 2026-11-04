import {
  inferenceConfig,
  modelIsVerified,
  resolveRunMode,
  VERIFIED_CHAT_MODELS,
} from "@/lib/config";
import { connection } from "next/server";

export async function GET() {
  await connection();
  const cfg = inferenceConfig();
  let mode: "mock" | "live" = "mock";
  let autoError: string | null = null;
  try {
    mode = resolveRunMode("auto");
  } catch (error) {
    autoError = error instanceof Error ? error.message : "Live mode is unavailable.";
  }
  return Response.json({
    mode,
    autoError,
    liveAvailable: cfg.liveAvailable,
    model: cfg.model,
    modelVerified: modelIsVerified(cfg.model),
    baseUrl: cfg.baseURL,
    threshold: cfg.threshold,
    verifiedModels: VERIFIED_CHAT_MODELS,
  });
}
