import type { Response } from "express";

/** Minimal server-sent-events writer. */
export class SseWriter {
  private closed = false;

  constructor(private res: Response) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(":ok\n\n");
    res.on("close", () => {
      this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(event: string, data: unknown): void {
    if (this.closed) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Default `message` event (consumed by fetch-based readers). */
  data(data: unknown): void {
    if (this.closed) return;
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  comment(text: string): void {
    if (this.closed) return;
    this.res.write(`:${text}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
  }
}
