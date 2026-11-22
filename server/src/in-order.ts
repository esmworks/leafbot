/**
 * Runs work for the same key in the order it was asked, while each piece's slow part (`prepare`) starts
 * at once. Events of a conversation look up who may see it before they are sent; those lookups finish
 * in any order (one waits on the database, the next is answered from a cache), so sending each as soon
 * as its lookup ended scrambled the reply streaming in. Here a piece is sent only after the one before.
 */
export function inOrder(onError: (err: unknown) => void) {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, prepare: () => Promise<T>, send: (value: T) => void): Promise<void> => {
    const ready = Promise.resolve().then(prepare);
    // Its failure is handled below, in turn; until then it must not count as unhandled.
    ready.catch(() => {});
    const tail = (tails.get(key) ?? Promise.resolve())
      .then(() => ready)
      .then(send)
      // One failed piece is reported and skipped; the ones after it still go.
      .catch(onError)
      .finally(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
    tails.set(key, tail);
    return tail;
  };
}
