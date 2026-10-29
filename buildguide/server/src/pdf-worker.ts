/**
 * Worker thread: pdfjs text extraction for one PDF. Receives the bytes via
 * workerData (transferred ArrayBuffer) and posts { totalPages, text } or { error }.
 */
import { parentPort, workerData } from "node:worker_threads";
import { extractText } from "unpdf";

async function run(): Promise<void> {
  const data = workerData as { buffer: ArrayBuffer };
  try {
    const result = await extractText(new Uint8Array(data.buffer), { mergePages: true });
    parentPort?.postMessage({ totalPages: result.totalPages, text: result.text || "" });
  } catch (e) {
    parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
}

void run();
