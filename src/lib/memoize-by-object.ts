/**
 * Memoize a pure function of an object by that object's identity, so each object
 * is computed once and keeps returning the same result object for as long as it
 * lives. The client's transcript cache keeps a message's objects while the
 * message stays cached, which is what makes this pay off there. Callers must
 * treat both the key and the result as immutable.
 *
 * Any further arguments must be fixed per key (e.g. derived from it); they are
 * not part of the cache key.
 */
export function memoizeByObject<K extends object, A extends unknown[], V>(
  compute: (key: K, ...rest: A) => V
): (key: K, ...rest: A) => V {
  const cache = new WeakMap<K, V>();
  return (key, ...rest) => {
    if (cache.has(key)) return cache.get(key) as V;
    const value = compute(key, ...rest);
    cache.set(key, value);
    return value;
  };
}
