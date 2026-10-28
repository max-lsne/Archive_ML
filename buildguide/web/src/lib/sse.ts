/**
 * Read a server-sent-events stream from a fetch() Response (needed because
 * EventSource cannot POST). Calls onEvent for every `data:` payload.
 */
export async function readSse(
  res: Response,
  onEvent: (data: string, event: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (chunk: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) onEvent(dataLines.join("\n"), event);
  };
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (chunk.trim() && !chunk.startsWith(":")) flush(chunk);
    }
  }
  if (buffer.trim() && !buffer.startsWith(":")) flush(buffer);
}
