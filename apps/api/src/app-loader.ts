/**
 * Cache one successfully-created app per warm serverless instance, but clear a
 * rejected initialization so the next request can recover from a transient
 * database or network failure.
 */
export function createRecoveringLoader<T>(factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;

  return () => {
    if (!pending) {
      const current = factory();
      pending = current;
      void current.catch(() => {
        if (pending === current) pending = undefined;
      });
    }
    return pending;
  };
}
