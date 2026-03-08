# distributed-lock

A lightweight distributed lock for Node.js microservices, powered by [ioredis](https://github.com/redis/ioredis).

- ⚡ **Single dependency** — only requires `ioredis`
- 🔒 **Atomic operations** — uses Redis `SET NX PX` + Lua scripts to guarantee safety
- 🔄 **Auto-extend** — optionally keep the lock alive until you explicitly release it
- 🔁 **Retry** — built-in retry with configurable count & delay
- 📦 **ESM + CJS** — ships both formats with full TypeScript types

## Installation

```bash
npm install distributed-lock ioredis
```

> `ioredis` is a **peer/co-dependency**. Make sure it's installed in your project.

## Quick Start

```ts
import Redis from "ioredis";
import { Lock } from "distributed-lock";

const redis = new Redis({ host: "localhost", port: 6379 });
const lock = new Lock(redis);

// Acquire a lock (single attempt)
const token = await lock.acquire("order:123");

if (token) {
  // ... do critical work ...
  await lock.release("order:123", token);
}
```

## API

### `new Lock(redis, options?)`

Create a new Lock instance.

| Param | Type | Description |
|---|---|---|
| `redis` | `Redis` | An ioredis instance |
| `options` | `LockOptions` | Global defaults (see below) |

#### `LockOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `ttl` | `number` | `10000` | Lock TTL in milliseconds |
| `prefix` | `string` | `"lock:"` | Prefix for Redis keys |

---

### `lock.acquire(resource, opts?)`

Acquire a distributed lock on a resource.

Returns the **owner token** (`string`) on success, or `null` on failure.

#### `AcquireOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `ttl` | `number` | global `ttl` | Override TTL for this call |
| `autoExtend` | `boolean` | `false` | Auto-refresh TTL (interval = ttl / 2) until released |
| `retryCount` | `number` | `0` | Number of retry attempts (`Infinity` = retry forever) |
| `retryDelay` | `number` | `200` | Delay in ms between retries |

```ts
// Single attempt (default)
const token = await lock.acquire("resource-key");

// With retry
const token = await lock.acquire("resource-key", {
  retryCount: 10,
  retryDelay: 500,
});

// With auto-extend (lock stays alive until release)
const token = await lock.acquire("resource-key", {
  autoExtend: true,
});

// Retry forever until acquired
const token = await lock.acquire("resource-key", {
  retryCount: Infinity,
  retryDelay: 1000,
  autoExtend: true,
});
```

---

### `lock.release(resource, token)`

Release a previously acquired lock. Uses a Lua script to ensure only the owner (matching token) can release it.

| Param | Type | Description |
|---|---|---|
| `resource` | `string` | The resource name |
| `token` | `string` | The token returned by `acquire()` |

Returns `true` if released, `false` if the lock was already expired or owned by someone else.

```ts
const released = await lock.release("resource-key", token);
```

---

### `lock.extend(resource, token, ttl?)`

Manually extend the TTL of a held lock (atomic via Lua script).

| Param | Type | Description |
|---|---|---|
| `resource` | `string` | The resource name |
| `token` | `string` | The token returned by `acquire()` |
| `ttl` | `number?` | New TTL in ms (defaults to global `ttl`) |

Returns `true` if extended, `false` if the lock was lost.

```ts
const ok = await lock.extend("resource-key", token, 15000);
```

---

### `lock.isLocked(resource)`

Check whether a resource is currently locked by anyone.

```ts
const locked = await lock.isLocked("resource-key");
// true | false
```

---

### `lock.using(resource, fn, opts?)`

Convenience wrapper: acquire → execute `fn()` → release (even if `fn` throws).

| Param | Type | Description |
|---|---|---|
| `resource` | `string` | The resource name |
| `fn` | `() => Promise<T>` | Async function to run while holding the lock |
| `opts` | `AcquireOptions?` | Same options as `acquire()` |

Throws an `Error` if the lock cannot be acquired.

```ts
const result = await lock.using("order:123", async () => {
  // ... critical section ...
  return { success: true };
});

// With retry + auto-extend
await lock.using(
  "order:123",
  async () => {
    // ... long-running critical section ...
  },
  { retryCount: 5, retryDelay: 1000, autoExtend: true }
);
```

## How It Works

1. **Acquire** — `SET key token PX ttl NX` (atomic set-if-not-exists with expiry)
2. **Release** — Lua script: delete key only if the stored value matches the owner token
3. **Extend** — Lua script: refresh TTL only if the stored value matches the owner token
4. **Auto-extend** — `setInterval` calls `extend()` every `ttl / 2` ms; stops automatically if the lock is lost or released

This ensures that:
- Only one client holds the lock at a time
- A crashed client's lock auto-expires after TTL
- No client can accidentally release another client's lock

## Use Cases

- **Microservices** — prevent duplicate processing of the same job/event
- **Cron jobs** — ensure only one instance runs a scheduled task
- **Rate limiting** — serialize access to a shared resource
- **Database migrations** — prevent concurrent schema changes

## License

MIT
