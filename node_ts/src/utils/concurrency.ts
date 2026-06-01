/**
 * Minimaler Concurrency-Limiter (Zero-Dependency-Ersatz für `p-limit`).
 *
 * Begrenzt, wie viele async-Tasks gleichzeitig laufen. FIFO: Tasks starten in
 * Aufruf-Reihenfolge, sobald ein Slot frei wird. API-kompatibel zu p-limit für
 * den Anwendungsfall im Runner: `const limit = createLimit(n); limit(() => task())`.
 */

export type LimitFunction = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Erzeugt einen Limiter mit der gegebenen maximalen Parallelität (>= 1).
 */
export function createLimit(concurrency: number): LimitFunction {
  const max = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: Array<() => void> = [];

  const dequeue = (): void => {
    if (active >= max) return;
    const run = queue.shift();
    if (!run) return;
    active += 1;
    run();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            dequeue();
          });
      });
      dequeue();
    });
}
