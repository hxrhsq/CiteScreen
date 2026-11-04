import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUpload, ParseError } from "./extract-file";

test("txt uploads decode as utf-8 and keep CJK", async () => {
  const text = await extractUpload("resume.txt", new TextEncoder().encode("李雷\n负责 Kubernetes 集群。"));
  assert.match(text, /李雷/);
  assert.match(text, /Kubernetes/);
});

test("unsupported types are rejected", async () => {
  await assert.rejects(extractUpload("notes.xlsx", new Uint8Array([1, 2, 3])), ParseError);
});
