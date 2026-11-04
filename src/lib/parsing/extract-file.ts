const MAX_BYTES = 8 * 1024 * 1024;

export class ParseError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ParseError";
    this.status = status;
  }
}

export function extensionOf(filename: string): string {
  const clean = filename.split(/[/\\]/).pop() ?? filename;
  const ext = clean.toLowerCase().split(".").pop() ?? "";
  return ext;
}

export async function extractUpload(filename: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0) throw new ParseError("That file is empty.");
  if (bytes.byteLength > MAX_BYTES) throw new ParseError("Files must be 8 MB or smaller.");
  const ext = extensionOf(filename);
  if (ext === "txt" || ext === "md" || ext === "text") {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
  }
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return result.value ?? "";
  }
  if (ext === "pdf") {
    const { extractText } = await import("unpdf");
    const result = await extractText(bytes, { mergePages: true });
    return result.text;
  }
  throw new ParseError("Upload a PDF, DOCX, or TXT file.");
}
