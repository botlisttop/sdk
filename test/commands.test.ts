import { Routes } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotListClient, BotListError, type BotListClientOptions } from '../src/index.js';
import { applicationCommandsRoute, hashCommands, prepareCommands } from '../src/commands.js';
import { BOT_ID, TOKEN, commandsOk, fakeClient, flush, jsonResponse, mockApi, ok } from './helpers.js';

const HOUR = 3_600_000;

const PING = {
  id: '111',
  application_id: BOT_ID,
  version: '1',
  type: 1,
  name: 'ping',
  description: 'Répond pong',
  name_localizations: { 'en-US': 'ping', fr: 'ping' },
  description_localizations: { fr: 'Répond pong', 'en-US': 'Replies pong' },
  default_member_permissions: null,
  dm_permission: true,
  nsfw: false,
  integration_types: [0],
};

const BAN = {
  id: '222',
  application_id: BOT_ID,
  version: '1',
  type: 1,
  name: 'ban',
  description: 'Bannit un membre',
  options: [
    {
      type: 6,
      name: 'membre',
      description: 'Membre à bannir',
      required: true,
      autocomplete: false,
    },
    {
      type: 3,
      name: 'durée',
      description: 'Durée',
      choices: [
        { name: '1 jour', value: '1d', name_localizations: null },
        { name: 'Définitif', value: 'perm' },
      ],
    },
  ],
};

const instances: BotListClient[] = [];
function create(client: BotListClient['client'], options: Partial<BotListClientOptions> = {}) {
  const botlist = new BotListClient(client, { token: TOKEN, postProfile: false, ...options });
  instances.push(botlist);
  return botlist;
}

function commandsBody(api: ReturnType<typeof mockApi>, call = 0) {
  return JSON.parse(String(api.calls('commands')[call]?.[1]?.body));
}

/** Laisse partir le premier signal de vie puis le premier envoi des commandes. */
async function boot() {
  await flush();
  // Un setTimeout(0) armé pendant un tick des faux timers part 1 ms plus tard.
  await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const botlist of instances.splice(0)) botlist.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('envoi des commandes slash', () => {
  it('envoie les commandes globales juste après le premier push réussi', async () => {
    const api = mockApi({ commands: [commandsOk({ commands_count: 2 })] });
    const fake = fakeClient({ commands: [PING, BAN] });
    const botlist = create(fake.client);
    const onCommands = vi.fn();
    botlist.on('commandsPosted', onCommands);

    await boot();

    const urls = api.fetch.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(['https://botlist.top/api/sdk/push', 'https://botlist.top/api/sdk/commands']);

    const [, init] = api.calls('commands')[0]!;
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    expect(commandsBody(api)).toEqual({ bot_id: BOT_ID, commands: prepareCommands([PING, BAN]) });
    expect(onCommands).toHaveBeenCalledWith(expect.objectContaining({ commands_count: 2, changed: true }));
  });

  it("n'envoie rien tant que le premier push n'a pas réussi", async () => {
    const api = mockApi({ push: [jsonResponse(503, {}), ok()] });
    create(fakeClient({ commands: [PING] }).client);

    await boot();
    expect(api.calls('commands')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(api.calls('commands')).toHaveLength(1);
  });

  it("ne garde que les champs retenus par Bot List, localisations comprises, triés par type puis nom", () => {
    const prepared = prepareCommands([PING, BAN, { type: 2, name: 'Profil', description: '' }]);

    expect(prepared.map((command) => command.name)).toEqual(['ban', 'ping', 'Profil']);
    expect(prepared[1]).toEqual({
      type: 1,
      name: 'ping',
      description: 'Répond pong',
      name_localizations: { 'en-US': 'ping', fr: 'ping' },
      description_localizations: { 'en-US': 'Replies pong', fr: 'Répond pong' },
      nsfw: false,
    });
    expect(prepared[0]!.options).toEqual([
      { type: 6, name: 'membre', description: 'Membre à bannir', required: true },
      { type: 3, name: 'durée', description: 'Durée', choices: [{ name: '1 jour' }, { name: 'Définitif' }] },
    ]);
  });

  it("l'empreinte ignore id, version et l'ordre des commandes", () => {
    const redeployed = [{ ...BAN, version: '2' }, { ...PING, id: '999', version: '5' }];
    expect(hashCommands(prepareCommands(redeployed))).toBe(hashCommands(prepareCommands([PING, BAN])));
  });

  it("ne renvoie pas une liste inchangée lors de la vérification horaire", async () => {
    const api = mockApi({});
    const fake = fakeClient({ commands: [PING] });
    create(fake.client, { debug: true });

    await boot();
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(fake.rest.get).toHaveBeenCalledTimes(3);
    expect(api.calls('commands')).toHaveLength(1);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Commandes inchangées, rien à envoyer.');
  });

  it('renvoie la liste quand elle change', async () => {
    const api = mockApi({});
    const fake = fakeClient({ commands: [PING] });
    create(fake.client);

    await boot();
    fake.setCommands([PING, BAN]);
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(api.calls('commands')).toHaveLength(2);
    expect(commandsBody(api, 1).commands).toHaveLength(2);
  });

  it("envoie une liste vide quand le bot n'a plus de commandes", async () => {
    const api = mockApi({});
    const fake = fakeClient({ commands: [PING] });
    create(fake.client);

    await boot();
    fake.setCommands([]);
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(commandsBody(api, 1)).toEqual({ bot_id: BOT_ID, commands: [] });
  });

  it("postCommands: false : rien n'est envoyé automatiquement", async () => {
    const api = mockApi({});
    const fake = fakeClient({ commands: [PING] });
    const botlist = create(fake.client, { postCommands: false });

    await boot();
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(fake.rest.get).not.toHaveBeenCalled();
    expect(api.calls('commands')).toHaveLength(0);
    expect(botlist.running).toBe(true);
  });

  it("postCommands() envoie immédiatement, même sans changement", async () => {
    const api = mockApi({});
    const botlist = create(fakeClient({ commands: [PING] }).client);
    const onCommands = vi.fn();
    botlist.on('commandsPosted', onCommands);

    await boot();
    const data = await botlist.postCommands();

    expect(data).toMatchObject({ bot_id: BOT_ID });
    expect(api.calls('commands')).toHaveLength(2);
    expect(onCommands).toHaveBeenCalledTimes(2);
  });

  it("postCommands() rejette avec une BotListError en cas d'échec", async () => {
    mockApi({ commands: [jsonResponse(422, { ok: false, error: 'validation_failed', message: 'bad' })] });
    const botlist = create(fakeClient({ commands: [PING] }).client, { autoPost: false });

    const error = await botlist.postCommands().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BotListError);
    expect(error).toMatchObject({ code: 'validation_failed', status: 422 });
  });

  it('une shard différente de 0 ne récupère ni n\'envoie rien', async () => {
    const api = mockApi({});
    const fake = fakeClient({
      commands: [PING],
      shard: { ids: [1], count: 2, fetchClientValues: async () => [1, 1] },
    });
    const botlist = create(fake.client);

    await boot();
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(api.fetch).not.toHaveBeenCalled();
    expect(fake.rest.get).not.toHaveBeenCalled();
    await expect(botlist.postCommands()).resolves.toBeNull();
  });

  it('ne récupère que les commandes globales, jamais celles des serveurs', async () => {
    mockApi({});
    const fake = fakeClient({ commands: [PING] });
    create(fake.client);

    await boot();
    await vi.advanceTimersByTimeAsync(HOUR);

    for (const [route, options] of fake.rest.get.mock.calls) {
      expect(route).toBe(Routes.applicationCommands(BOT_ID));
      expect(route).not.toContain('/guilds/');
      expect(options?.query?.get('with_localizations')).toBe('true');
    }
    expect(applicationCommandsRoute(BOT_ID)).toBe(Routes.applicationCommands(BOT_ID));
  });
});

describe('erreurs sur /commands', () => {
  it('401 sur /commands arrête aussi le signal de vie', async () => {
    const api = mockApi({ commands: [jsonResponse(401, { ok: false, error: 'invalid_token' })] });
    const botlist = create(fakeClient({ commands: [PING] }).client);
    const onError = vi.fn();
    botlist.on('error', onError);

    await boot();
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(botlist.running).toBe(false);
    expect(api.calls('push')).toHaveLength(1);
    expect(api.calls('commands')).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'invalid_token', status: 401 });
  });

  it("401 sur /push arrête aussi l'envoi des commandes", async () => {
    const api = mockApi({ push: [ok(), jsonResponse(401, { ok: false, error: 'invalid_token' })] });
    const fake = fakeClient({ commands: [PING] });
    const botlist = create(fake.client);
    botlist.on('error', () => {});

    await boot();
    await vi.advanceTimersByTimeAsync(300_000);
    fake.setCommands([PING, BAN]);
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(botlist.running).toBe(false);
    expect(api.calls('commands')).toHaveLength(1);
  });

  it("413 n'est pas réessayé tant que la liste ne change pas", async () => {
    const api = mockApi({
      commands: [jsonResponse(413, { ok: false, error: 'payload_too_large', message: 'Too large' }), commandsOk()],
    });
    const fake = fakeClient({ commands: [PING] });
    const botlist = create(fake.client);
    const onError = vi.fn();
    botlist.on('error', onError);

    await boot();
    await vi.advanceTimersByTimeAsync(3 * HOUR);

    expect(api.calls('commands')).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'payload_too_large', status: 413 });
    expect(botlist.running).toBe(true);

    fake.setCommands([BAN]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(api.calls('commands')).toHaveLength(2);
  });

  it('429 sur /commands attend retry_after sans retarder le signal de vie', async () => {
    const api = mockApi({
      commands: [jsonResponse(429, { ok: false, error: 'rate_limited', retry_after: 45 }), commandsOk()],
    });
    const botlist = create(fakeClient({ commands: [PING] }).client);
    const onRateLimited = vi.fn();
    botlist.on('ratelimited', onRateLimited);

    await boot();
    expect(onRateLimited).toHaveBeenCalledWith(45);

    await vi.advanceTimersByTimeAsync(44_000);
    expect(api.calls('commands')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.calls('commands')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(255_000);
    expect(api.calls('push')).toHaveLength(2);
  });

  it("un 5xx sur /commands n'affecte pas /push", async () => {
    const api = mockApi({ commands: [jsonResponse(503, { message: 'down' })] });
    const botlist = create(fakeClient({ commands: [PING] }).client);
    const onError = vi.fn();
    botlist.on('error', onError);

    await boot();
    // Commandes : nouvel essai après 30 s, 60 s, 120 s ; signal de vie toutes les 300 s.
    await vi.advanceTimersByTimeAsync(900_000);

    expect(api.calls('push')).toHaveLength(4);
    expect(api.calls('commands').length).toBeGreaterThanOrEqual(4);
    expect(onError.mock.calls.every(([error]) => error.code === 'server_error')).toBe(true);
    expect(botlist.running).toBe(true);
  });

  it("une erreur Discord à la récupération émet commands_fetch_failed sans casser le signal de vie", async () => {
    const api = mockApi({});
    const fake = fakeClient();
    fake.rest.get.mockRejectedValue(new Error('Missing Access'));
    const botlist = create(fake.client);
    const onError = vi.fn();
    botlist.on('error', onError);

    await boot();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'commands_fetch_failed' });
    expect(api.calls('commands')).toHaveLength(0);
    expect(api.calls('push')).toHaveLength(3);
  });

  it('stop() arrête aussi la vérification des commandes', async () => {
    const api = mockApi({});
    const fake = fakeClient({ commands: [PING] });
    const botlist = create(fake.client);

    await boot();
    botlist.stop();
    fake.setCommands([PING, BAN]);
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(api.calls('commands')).toHaveLength(1);
  });

  it('le minuteur des commandes ne retient pas le process (unref)', async () => {
    mockApi({});
    create(fakeClient({ commands: [PING] }).client);
    const unref = vi.spyOn(globalThis, 'setTimeout');
    await boot();
    const timers = unref.mock.results.map((result) => result.value as NodeJS.Timeout);
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.every((timer) => typeof timer.hasRef !== 'function' || !timer.hasRef())).toBe(true);
  });
});
