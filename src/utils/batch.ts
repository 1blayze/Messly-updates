export function createMicrotaskBatcher<T>(flush: (items: T[]) => void): (item: T) => void {
  let queue: T[] = [];
  let scheduled = false;

  return (item: T): void => {
    queue.push(item);
    if (scheduled) {
      return;
    }

    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const items = queue;
      queue = [];
      flush(items);
    });
  };
}
