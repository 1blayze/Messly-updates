export function createDebouncedTask<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delayMs: number,
): ((...args: TArgs) => void) & { cancel: () => void } {
  let timerId: number | null = null;

  const run = (...args: TArgs): void => {
    if (timerId != null) {
      window.clearTimeout(timerId);
    }

    timerId = window.setTimeout(() => {
      timerId = null;
      callback(...args);
    }, delayMs);
  };

  run.cancel = (): void => {
    if (timerId != null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };

  return run;
}
