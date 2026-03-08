import Redis from "ioredis";
import crypto from "crypto";

export interface LockOptions {
  /** Lock TTL in milliseconds (default: 10000ms) */
  ttl?: number;
  /** Prefix for Redis keys (default: "lock:") */
  prefix?: string;
}

export interface AcquireOptions {
  /** Override TTL for this specific acquire call */
  ttl?: number;
  /**
   * Automatically extend the lock before it expires.
   * When enabled, a background interval (ttl / 2) will keep refreshing the TTL
   * until the lock is released. (default: false)
   */
  autoExtend?: boolean;
  /**
   * Number of retry attempts. If not set, acquire once (no retry).
   * Set to `Infinity` to retry indefinitely.
   */
  retryCount?: number;
  /** Delay in ms between each retry attempt (default: 200) */
  retryDelay?: number;
}

const DEFAULT_OPTIONS: Required<LockOptions> = {
  ttl: 10_000,
  prefix: "lock:",
};

// Lua script: release lock only if the value matches (atomic)
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

// Lua script: extend lock TTL only if the value matches (atomic)
const EXTEND_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

export default class Lock {
  private readonly redis: Redis;
  private readonly options: Required<LockOptions>;

  /** Map of "resourceKey:token" -> auto-extend timer */
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(redis: Redis, options?: LockOptions) {
    this.redis = redis;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ───────────────────────── public API ─────────────────────────

  /**
   * Acquire a distributed lock on the given resource.
   * By default, tries once. If `retryCount` is set, retries up to that many times
   * with `retryDelay` ms between attempts.
   *
   * @param resource - Unique name of the resource to lock.
   * @param opts     - Per-call options: ttl, autoExtend, retryCount, retryDelay.
   * @returns The owner token (string) on success, or `null` if the lock could not be acquired.
   */
  async acquire(
    resource: string,
    opts?: AcquireOptions
  ): Promise<string | null> {
    const ttl = opts?.ttl ?? this.options.ttl;
    const retryCount = opts?.retryCount ?? 0;
    const retryDelay = opts?.retryDelay ?? 200;
    const key = this.keyFor(resource);
    const token = this.generateToken();

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      // SET key token PX ttl NX  →  atomic "set if not exists" with expiry

      const result = await this.redis.set(key, token, "PX", ttl, "NX");

      if (result === "OK") {
        // Start auto-extend if requested
        if (opts?.autoExtend) {
          this.startAutoExtend(resource, key, token, ttl);
        }
        return token;
      }

      // Wait before next attempt (skip on last attempt)
      if (attempt < retryCount) {
        await this.sleep(retryDelay);
      }
    }

    return null;
  }

  /**
   * Release a previously acquired lock.
   *
   * @param resource - The resource name used when acquiring.
   * @param token    - The owner token returned by `acquire()`.
   * @returns `true` if the lock was released, `false` otherwise.
   */
  async release(resource: string, token: string): Promise<boolean> {
    const key = this.keyFor(resource);

    // Stop auto-extend timer if any
    this.stopAutoExtend(`${key}:${token}`);

    const result = await this.redis.eval(RELEASE_SCRIPT, 1, key, token);

    return result === 1;
  }

  /**
   * Extend the TTL of a currently held lock.
   *
   * @param resource - The resource name.
   * @param token    - The owner token returned by `acquire()`.
   * @param ttl      - New TTL in milliseconds (default: original TTL).
   * @returns `true` if the lock was extended, `false` otherwise.
   */
  async extend(
    resource: string,
    token: string,
    ttl?: number
  ): Promise<boolean> {
    const key = this.keyFor(resource);
    const effectiveTtl = ttl ?? this.options.ttl;

    const result = await this.redis.eval(
      EXTEND_SCRIPT,
      1,
      key,
      token,
      effectiveTtl
    );

    return result === 1;
  }

  /**
   * Check whether a resource is currently locked (by anyone).
   */
  async isLocked(resource: string): Promise<boolean> {
    const key = this.keyFor(resource);
    const exists = await this.redis.exists(key);
    return exists === 1;
  }

  /**
   * Convenience helper: acquire the lock, execute `fn`, then release.
   *
   * @param resource - Resource name.
   * @param fn       - Async function to execute while holding the lock.
   * @param opts     - Per-call acquire options.
   * @throws {Error} If the lock cannot be acquired.
   */
  async using<T>(
    resource: string,
    fn: () => Promise<T>,
    opts?: AcquireOptions
  ): Promise<T> {
    const token = await this.acquire(resource, opts);

    if (!token) {
      throw new Error(`Failed to acquire lock on resource "${resource}".`);
    }

    try {
      return await fn();
    } finally {
      await this.release(resource, token);
    }
  }

  // ───────────────────────── internals ──────────────────────────

  private keyFor(resource: string): string {
    return `${this.options.prefix}${resource}`;
  }

  private generateToken(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  private startAutoExtend(
    resource: string,
    key: string,
    token: string,
    ttl: number
  ): void {
    const interval = Math.floor(ttl / 2);
    const timerKey = `${key}:${token}`;
    const timer = setInterval(async () => {
      const ok = await this.extend(resource, token, ttl);
      if (!ok) {
        this.stopAutoExtend(timerKey);
      }
    }, interval);

    if (timer.unref) {
      timer.unref();
    }

    this.timers.set(timerKey, timer);
  }

  private stopAutoExtend(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
