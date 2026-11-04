import { errorResponse, asScreenInput, readJson } from "@/lib/http";
import { screenWithMode } from "@/lib/screening/pipeline";

export async function POST(request: Request) {
  try {
    const input = asScreenInput(await readJson(request));
    const report = await screenWithMode(input);
    return Response.json(report);
  } catch (error) {
    return errorResponse(error);
  }
}
