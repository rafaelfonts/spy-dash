type SSEEvent = { type: string; payload: any };

export class SSEBatcher {
  private buffer: SSEEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly windowMs: number;
  private readonly flush: (events: SSEEvent[]) => void;

  constructor(windowMs: number, flush: (events: SSEEvent[]) => void) {
    this.windowMs = windowMs;
    this.flush = flush;
  }

  emit(event: SSEEvent) {
    this.buffer.push(event);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush([...this.buffer]);
        this.buffer = [];
        this.timer = null;
      }, this.windowMs);
    }
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
  }
}
