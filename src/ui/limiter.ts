/**
 * Papertrade rate limits new /state/user/live connections per client (Cloudflare error 1015, HTTP 429 with retry-after).
 * This wrapper spaces connection starts out and, after a 429, holds every new connection until the cooldown ends,
 * so the SDK's reconnect loop cannot dig the hole deeper.
 */
export interface LimitedFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Epoch ms until which new connections are held, or 0. */
  cooldownUntil(): number;
  /** Connections started since creation. */
  started(): number;
  /** Subscribe to cooldown changes. */
  onCooldown(listener: (until: number) => void): void;
}

export interface LimiterOptions {
  fetch?: typeof fetch;
  /** Minimum spacing between connection starts. */
  gapMs?: number;
  /** Cooldown applied when a 429 carries no usable retry-after, or the browser hides the response. */
  defaultCooldownMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

function sleepAbortable(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function retryAfterMs(res: Pick<Response, 'headers'>, fallbackMs: number): number {
  const header = res.headers.get('retry-after');
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(300, seconds) * 1000 + 500 : fallbackMs;
}

export function createLimitedFetch(options: LimiterOptions = {}): LimitedFetch {
  const base = options.fetch ?? globalThis.fetch.bind(globalThis);
  const gapMs = options.gapMs ?? 1_500;
  const fallback = options.defaultCooldownMs ?? 30_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepAbortable;
  const listeners: ((until: number) => void)[] = [];
  let cooldownUntil = 0;
  let nextStart = 0;
  let started = 0;

  const setCooldown = (until: number) => {
    cooldownUntil = Math.max(cooldownUntil, until);
    for (const l of listeners) l(cooldownUntil);
  };

  /** Reserve the next start slot. Slots are handed out in call order, so waiting never reorders connections. */
  const reserve = (): number => {
    const slot = Math.max(now(), nextStart, cooldownUntil);
    nextStart = slot + gapMs;
    return slot;
  };

  const limited = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    for (;;) {
      const slot = reserve();
      await sleep(Math.max(0, slot - now()), init?.signal);
      if (now() < cooldownUntil) continue;
      started++;
      try {
        const res = await base(input, init);
        if (res.status === 429) setCooldown(now() + retryAfterMs(res, fallback));
        return res;
      } catch (err) {
        if (init?.signal?.aborted) throw err;
        // A 429 from the edge carries no CORS headers, so the browser reports a bare network error.
        // Back off for the default cooldown instead of reconnecting at full speed.
        setCooldown(now() + fallback);
        throw err;
      }
    }
  }) as LimitedFetch;
  limited.cooldownUntil = () => (cooldownUntil > now() ? cooldownUntil : 0);
  limited.started = () => started;
  limited.onCooldown = (l) => void listeners.push(l);
  return limited;
}
