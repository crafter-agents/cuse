import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OS } from "./os.ts";
import { ocrReadCmd } from "./commands.ts";
import { runWithTimeout } from "./exec.ts";

const SWIFT_SOURCE = `import Vision
import AppKit

let path = CommandLine.arguments[1]
guard let img = NSImage(byReferencingFile: path),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cgImage = rep.cgImage else {
    FileHandle.standardError.write("could not load image\\n".data(using: .utf8)!)
    exit(1)
}

let semaphore = DispatchSemaphore(value: 0)
var lines: [String] = []
var errorMsg: String? = nil

let request = VNRecognizeTextRequest { req, err in
    if let err = err {
        errorMsg = err.localizedDescription
    } else if let results = req.results as? [VNRecognizedTextObservation] {
        for obs in results {
            if let top = obs.topCandidates(1).first {
                lines.append(top.string)
            }
        }
    }
    semaphore.signal()
}
request.recognitionLevel = .accurate

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("recognition failed: \\(error.localizedDescription)\\n".data(using: .utf8)!)
    exit(1)
}
semaphore.wait()

if let errorMsg = errorMsg {
    FileHandle.standardError.write("recognition failed: \\(errorMsg)\\n".data(using: .utf8)!)
    exit(1)
}

let text = lines.joined(separator: "\\n")
func jsonString(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s])
    let encoded = String(data: data, encoding: .utf8)!
    return String(encoded.dropFirst().dropLast())
}
let escapedLines = lines.map(jsonString)
print("{\\"text\\":\\(jsonString(text)),\\"lines\\":[\\(escapedLines.joined(separator: ","))]}")
`;

export async function recognizeText(
  os: OS,
  imagePath: string,
  timeoutMs: number,
): Promise<{ text: string; lines: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "cuse-ocr-"));
  const scriptPath = join(dir, "ocr.swift");
  try {
    await writeFile(scriptPath, SWIFT_SOURCE);
    const result = await runWithTimeout(ocrReadCmd(os, scriptPath, imagePath), timeoutMs);
    if (result.timedOut) throw new Error(`ocr-read did not finish within ${timeoutMs}ms`);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim().split("\n")[0] || "ocr-read failed");
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim());
      if (!parsed || typeof parsed !== "object" ||
          typeof (parsed as { text?: unknown }).text !== "string" ||
          !Array.isArray((parsed as { lines?: unknown }).lines) ||
          !(parsed as { lines: unknown[] }).lines.every((line) => typeof line === "string")) {
        throw new Error("invalid OCR result shape");
      }
      return parsed as { text: string; lines: string[] };
    } catch {
      throw new Error("ocr-read returned unparseable output");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
