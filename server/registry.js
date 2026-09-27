// Registry contract: synchronous local reservation; a distributed adapter must supply
// atomic admission + fenced ownership, not simply substitute Redis get/set calls.
export class StreamRegistry {
  get(_id) {
    throw new Error('Not implemented');
  }
  set(_id, _entry) {
    throw new Error('Not implemented');
  }
  delete(_id) {
    throw new Error('Not implemented');
  }
  values() {
    throw new Error('Not implemented');
  }
}
export class MemoryRegistry extends StreamRegistry {
  #entries = new Map();
  get(id) {
    return this.#entries.get(id);
  }
  set(id, entry) {
    this.#entries.set(id, entry);
  }
  delete(id) {
    this.#entries.delete(id);
  }
  values() {
    return [...this.#entries.values()];
  }
}
export class KeyedMutex {
  #tails = new Map();
  async run(key, fn) {
    const previous = this.#tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
export class RateLimiter {
  constructor(limit, windowMs, maxKeys = 10000) {
    Object.assign(this, { limit, windowMs, maxKeys });
    this.entries = new Map();
  }
  allow(key, now = Date.now()) {
    let e = this.entries.get(key);
    if (!e || now >= e.until) {
      this.sweep(now);
      if (!e && this.entries.size >= this.maxKeys) return false;
      e = { count: 0, until: now + this.windowMs };
      this.entries.set(key, e);
    }
    return ++e.count <= this.limit;
  }
  sweep(now = Date.now()) {
    for (const [k, v] of this.entries) if (now >= v.until) this.entries.delete(k);
  }
}
