export class SerialExecutor {
  private chain: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class SingleFlight<T> {
  private inFlight: Promise<T> | null = null;

  run(task: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = task().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  get active(): boolean {
    return Boolean(this.inFlight);
  }
}

export class SequentialLock {
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
