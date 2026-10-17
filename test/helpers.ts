import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { vi } from 'vitest';

export const TOKEN = 'blt_secret_test_token_123';
export const BOT_ID = '123456789012345678';

interface FakeShard {
  ids: number[];
  count: number;
  fetchClientValues: (prop: string) => Promise<unknown[]>;
}

interface FakeClientOptions {
  guilds?: number;
  ready?: boolean;
  shard?: FakeShard | null;
}

export function fakeClient({ guilds = 42, ready = true, shard = null }: FakeClientOptions = {}) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let isReady = ready;
  Object.assign(emitter, {
    user: ready ? { id: BOT_ID } : null,
    guilds: { cache: { size: guilds } },
    ws: { shards: new Map([[0, {}]]) },
    shard,
    isReady: () => isReady,
  });
  return {
    client: emitter as unknown as Client,
    setReady() {
      isReady = true;
      emitter.user = { id: BOT_ID };
      emitter.emit('clientReady', emitter);
    },
  };
}

export function successData(overrides: Record<string, unknown> = {}) {
  return {
    bot_id: BOT_ID,
    server_count: 42,
    shard_count: 1,
    online: true,
    received_at: '2026-10-17T12:00:00Z',
    next_push_in: 300,
    online_window: 900,
    ...overrides,
  };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export const ok = (overrides?: Record<string, unknown>) => jsonResponse(200, { ok: true, data: successData(overrides) });

type MockedResponse = Response | Error | (() => Response | Promise<Response>);

/** Remplace fetch par un mock qui renvoie les réponses fournies dans l'ordre (la dernière est répétée). */
export function mockFetch(...responses: MockedResponse[]) {
  let index = 0;
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next.clone();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function sentBody(fetchMock: ReturnType<typeof mockFetch>, call = 0) {
  const init = fetchMock.mock.calls[call]?.[1];
  return JSON.parse(String(init?.body));
}

/** Laisse s'exécuter les timers à 0 ms et les promesses en attente. */
export async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
