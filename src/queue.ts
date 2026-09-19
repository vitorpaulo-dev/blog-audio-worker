export interface PromptQueue {
  enqueue<T>(task: (waitedMs: number) => Promise<T>): Promise<T>;
}

export function createSingleFlightQueue(): PromptQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: (waitedMs: number) => Promise<T>): Promise<T> {
      const enqueuedAt = Date.now();
      const run = tail.then(() => task(Math.max(0, Date.now() - enqueuedAt)));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
