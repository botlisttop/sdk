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
  /** Commandes globales renvoyées par le faux `client.rest.get`. */
  commands?: unknown[];
  /** Compte du bot renvoyé par le faux `client.rest.get('/users/@me')`. */
  profile?: Record<string, unknown>;
}

export const AVATAR = 'a'.repeat(32);
export const BANNER = 'b'.repeat(32);

export function botUser(overrides: Record<string, unknown> = {}) {
  return { id: BOT_ID, username: 'Mon Bot', discriminator: '0', avatar: AVATAR, banner: BANNER, bot: true, ...overrides };
}

export function fakeClient({
  guilds = 42,
  ready = true,
  shard = null,
  commands = [],
  profile = botUser(),
}: FakeClientOptions = {}) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let isReady = ready;
  let currentCommands = commands;
  let currentProfile = profile;
  const rest = {
    get: vi.fn(
      async (route: string, _options?: { query?: URLSearchParams }): Promise<unknown> =>
        route === '/users/@me' ? currentProfile : currentCommands,
    ),
  };
  Object.assign(emitter, {
    user: ready ? { id: BOT_ID } : null,
    application: ready ? { id: BOT_ID } : null,
    guilds: { cache: { size: guilds } },
    ws: { shards: new Map([[0, {}]]) },
    rest,
    shard,
    isReady: () => isReady,
  });
  return {
    client: emitter as unknown as Client,
    rest,
    /** Change la liste renvoyée par Discord. */
    setCommands(next: unknown[]) {
      currentCommands = next;
    },
    /** Change le compte renvoyé par Discord, sans émettre d'événement. */
    setProfile(next: Record<string, unknown>) {
      currentProfile = next;
    },
    /** Change le compte et émet `userUpdate`, comme discord.js après un USER_UPDATE. */
    updateUser(next: Record<string, unknown>) {
      const previous = currentProfile;
      currentProfile = next;
      emitter.emit('userUpdate', previous, next);
    },
    setReady() {
      isReady = true;
      emitter.user = { id: BOT_ID };
      emitter.application = { id: BOT_ID };
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

export const commandsOk = (overrides: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    ok: true,
    data: { bot_id: BOT_ID, commands_count: 0, changed: true, received_at: '2026-10-20T12:00:00Z', ...overrides },
  });

export const profileOk = (overrides: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    ok: true,
    data: { bot_id: BOT_ID, changed: true, review_required: false, received_at: '2026-10-21T12:00:00Z', ...overrides },
  });

type Route = 'push' | 'commands' | 'profile';

function routeOf(url: unknown): Route {
  const path = String(url);
  if (path.endsWith('/api/sdk/commands')) return 'commands';
  if (path.endsWith('/api/sdk/profile')) return 'profile';
  return 'push';
}

/**
 * Remplace fetch par un mock qui répond selon l'endpoint appelé. Chaque liste est
 * consommée dans l'ordre, la dernière réponse étant répétée.
 */
export function mockApi(routes: Partial<Record<Route, MockedResponse[]>>) {
  const queues: Record<Route, MockedResponse[]> = {
    push: routes.push ?? [ok()],
    commands: routes.commands ?? [commandsOk()],
    profile: routes.profile ?? [profileOk()],
  };
  const counters: Record<Route, number> = { push: 0, commands: 0, profile: 0 };
  const fn = vi.fn(async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const route = routeOf(url);
    const queue = queues[route];
    const next = queue[Math.min(counters[route], queue.length - 1)]!;
    counters[route] += 1;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next.clone();
  });
  vi.stubGlobal('fetch', fn);
  return {
    fetch: fn,
    calls: (route: Route) => fn.mock.calls.filter(([url]) => routeOf(url) === route),
  };
}

export function sentBody(fetchMock: ReturnType<typeof mockFetch>, call = 0) {
  const init = fetchMock.mock.calls[call]?.[1];
  return JSON.parse(String(init?.body));
}

/** Laisse s'exécuter les timers à 0 ms et les promesses en attente. */
export async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
