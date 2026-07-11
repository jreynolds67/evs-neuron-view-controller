// server/cache.js
// A tiny per-key TTL cache that ALSO coalesces concurrent misses. This is the mechanism
// that keeps board load flat as panels scale: many panels poll the same head's preview
// every few seconds, and without coalescing, N simultaneous cache misses would still fire
// N board requests (none has resolved yet to populate the cache). By caching the in-flight
// promise, all concurrent callers for the same key share ONE board fetch.
//
// Result: board traffic scales with the number of distinct heads/cards being viewed, not
// with (panels × heads). A fresh value is served straight from memory within its TTL.

export function createTtlCache(defaultTtlMs, opts = {}) {
  // key -> { value, at }         (resolved, cached values)
  const store = new Map();
  // key -> Promise                (in-flight fetches, shared by concurrent callers)
  const inflight = new Map();
  // key -> { err, at }            (recent failures, cached briefly — see negTtlMs)
  const negative = new Map();
  // How long to remember a failure. A down/rebooting board otherwise gets a fresh fetch
  // attempt (each with the full board timeout) on every poll; caching the failure for a few
  // seconds lets it recover without being hammered. 0 disables negative caching.
  const negTtlMs = opts.negativeTtlMs || 0;

  async function get(key, producer, ttlMs = defaultTtlMs) {
    const hit = store.get(key);
    if (hit && (Date.now() - hit.at) < ttlMs) return hit.value;

    // Recent failure still within the negative window — rethrow it without hitting the board.
    if (negTtlMs) {
      const neg = negative.get(key);
      if (neg && (Date.now() - neg.at) < negTtlMs) throw neg.err;
    }

    // A fetch for this key is already running — join it instead of starting another.
    const pending = inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const value = await producer();
        store.set(key, { value, at: Date.now() });
        if (negTtlMs) negative.delete(key);
        return value;
      } catch (err) {
        if (negTtlMs) negative.set(key, { err, at: Date.now() });
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  // Drop a key (e.g. after a write that we know changed the underlying data).
  function invalidate(key) {
    store.delete(key);
    negative.delete(key);
  }

  // Periodic prune so the maps can't grow without bound from transient keys.
  function prune(maxAgeMs) {
    const now = Date.now();
    for (const [k, v] of store) if (now - v.at >= maxAgeMs) store.delete(k);
    for (const [k, v] of negative) if (now - v.at >= maxAgeMs) negative.delete(k);
  }

  return { get, invalidate, prune };
}
