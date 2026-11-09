// Only replaceable UI publications are coalesced. Producers retain every raw
// delta/tool event before scheduling; terminal paths flush before teardown.
export class StreamPublicationQueue {
  private pending = new Map<object, () => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  schedule(owner: object, publish: () => void): void {
    this.pending.set(owner, publish);
    this.timer ??= setTimeout(() => this.drain(), 40);
  }

  flush(owner: object): void {
    const publish = this.pending.get(owner);
    this.pending.delete(owner);
    publish?.();
    if (!this.pending.size && this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private drain(): void {
    this.timer = undefined;
    const started = performance.now();
    try {
      for (const owner of [...this.pending.keys()]) {
        this.flush(owner);
        if (performance.now() - started >= 4) break;
      }
    } finally {
      // Timers are intentional: background WebViews may suspend rAF entirely.
      if (this.pending.size) this.timer ??= setTimeout(() => this.drain(), 40);
    }
  }
}

export const streamPublications = new StreamPublicationQueue();
