import { errorResponse } from "@/lib/http";
import { extractUpload, ParseError } from "@/lib/parsing/extract-file";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ParseError("Choose a PDF, DOCX, or TXT file.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = (await extractUpload(file.name || "resume.txt", bytes)).replace(/\u0000/g, "").trim();
    if (text.length < 20) {
      throw new ParseError(
        "No usable text came out of that file. Scanned PDFs have no text layer — paste the resume instead.",
        422,
      );
    }
    const name = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? file.name;
    return Response.json({
      filename: file.name,
      name: name.slice(0, 80),
      text,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
