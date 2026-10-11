import { describe, expect, it } from 'vitest';
import { createLimitedFetch, retryAfterMs } from '../src/ui/limiter.js';

function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleeps,
    /** Virtual time: a sleep resolves at its target instant and never rewinds the clock. */
    sleep: async (ms: number) => {
      sleeps.push(ms);
      const at = t + ms;
      await Promise.resolve();
      t = Math.max(t, at);
    },
  };
}

describe('retryAfterMs', () => {
  it('reads seconds from the header and pads them', () => {
    expect(retryAfterMs(new Response(null, { headers: { 'retry-after': '36' } }), 1)).toBe(36_500);
  });
  it('falls back when the header is missing or not a number', () => {
    expect(retryAfterMs(new Response(null), 7)).toBe(7);
    expect(retryAfterMs(new Response(null, { headers: { 'retry-after': 'soon' } }), 7)).toBe(7);
  });
  it('caps an absurd retry-after at five minutes', () => {
    expect(retryAfterMs(new Response(null, { headers: { 'retry-after': '99999' } }), 1)).toBe(300_500);
  });
});

describe('createLimitedFetch', () => {
  it('spaces connection starts by the gap', async () => {
    const starts: number[] = [];
    const f = createLimitedFetch({ fetch: async () => (starts.push(performance.now()), new Response('ok')), gapMs: 40 });
    await Promise.all([f('a'), f('b'), f('c')]);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(35);
    expect(f.started()).toBe(3);
  });

  it('holds every new connection until a 429 cooldown ends', async () => {
    const c = clock();
    const starts: number[] = [];
    let first = true;
    const f = createLimitedFetch({
      gapMs: 100,
      now: c.now,
      sleep: c.sleep,
      fetch: async () => {
        starts.push(c.now());
        if (first) {
          first = false;
          return new Response('limited', { status: 429, headers: { 'retry-after': '36' } });
        }
        return new Response('ok');
      },
    });
    const seen: number[] = [];
    f.onCooldown((until) => seen.push(until));
    const limited = await f('a');
    expect(limited.status).toBe(429);
    expect(f.cooldownUntil()).toBe(starts[0]! + 36_500);
    expect(seen).toEqual([starts[0]! + 36_500]);
    await f('b');
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(36_500);
  });

  it('backs off after a network error and rethrows it', async () => {
    const c = clock();
    const f = createLimitedFetch({ gapMs: 100, now: c.now, sleep: c.sleep, fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(f('a')).rejects.toThrow('Failed to fetch');
    expect(f.cooldownUntil()).toBeGreaterThanOrEqual(c.now() + 30_000);
  });

  it('does not start a connection whose signal was aborted while waiting', async () => {
    const ctrl = new AbortController();
    const f = createLimitedFetch({ fetch: async () => new Response('ok'), gapMs: 5_000 });
    await f('a');
    const pending = f('b', { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.started()).toBe(1);
  });
});
