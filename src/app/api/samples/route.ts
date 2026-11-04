import { loadJobs, loadResumes } from "@/lib/screening/samples";
import { connection } from "next/server";

export async function GET() {
  await connection();
  return Response.json({
    jobs: loadJobs().map(({ id, title, company, text }) => ({ id, title, company, text })),
    resumes: loadResumes(),
  });
}
