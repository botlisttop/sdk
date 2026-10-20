import { Routes } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotListClient, BotListError, type BotListClientOptions } from '../src/index.js';
import { CURRENT_USER_ROUTE } from '../src/profile.js';
import { AVATAR, BANNER, BOT_ID, botUser, fakeClient, flush, jsonResponse, mockApi, profileOk, TOKEN } from './helpers.js';

const HOUR = 3_600_000;

const instances: BotListClient[] = [];
function create(client: BotListClient['client'], options: Partial<BotListClientOptions> = {}) {
  const botlist = new BotListClient(client, { token: TOKEN, postCommands: false, ...options });
  instances.push(botlist);
  return botlist;
}

function profileBody(api: ReturnType<typeof mockApi>, call = 0) {
  return JSON.parse(String(api.calls('profile')[call]?.[1]?.body));
}

function profileFetches(fake: ReturnType<typeof fakeClient>) {
  return fake.rest.get.mock.calls.filter(([route]) => route === CURRENT_USER_ROUTE);
}

/** Laisse partir le premier signal de vie puis le premier envoi du profil. */
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

describe('envoi du profil', () => {
  it("envoie le nom, l'avatar et la bannière juste après le premier push réussi", async () => {
    const api = mockApi({});
    const fake = fakeClient();
    const botlist = create(fake.client, { postCommands: true });
    const onProfile = vi.fn();
    botlist.on('profilePosted', onProfile);

    await boot();

    const urls = api.fetch.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toBe('https://botlist.top/api/sdk/push');
    expect(urls.slice(1).sort()).toEqual(['https://botlist.top/api/sdk/commands', 'https://botlist.top/api/sdk/profile']);

    const [, init] = api.calls('profile')[0]!;
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    expect(profileBody(api)).toEqual({ bot_id: BOT_ID, username: 'Mon Bot', avatar: AVATAR, banner: BANNER });
    expect(onProfile).toHaveBeenCalledWith(expect.objectContaining({ changed: true, review_required: false }));
    expect(CURRENT_USER_ROUTE).toBe(Routes.user());
  });

  it("n'envoie rien tant que le premier push n'a pas réussi", async () => {
    const api = mockApi({ push: [jsonResponse(503, {}), jsonResponse(200, { ok: true, data: {} })] });
    create(fakeClient().client);

    await boot();
    expect(api.calls('profile')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(api.calls('profile')).toHaveLength(1);
  });

  it('envoie null pour un avatar ou une bannière absents', async () => {
    const api = mockApi({});
    create(fakeClient({ profile: botUser({ avatar: null, banner: undefined }) }).client);

    await boot();

    expect(profileBody(api)).toEqual({ bot_id: BOT_ID, username: 'Mon Bot', avatar: null, banner: null });
  });

  it('ne renvoie pas un profil inchangé lors de la vérification horaire', async () => {
    const api = mockApi({});
    const fake = fakeClient();
    create(fake.client, { debug: true });

    await boot();
    await vi.advanceTimersByTimeAsync(HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(profileFetches(fake)).toHaveLength(3);
    expect(api.calls('profile')).toHaveLength(1);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Profil inchangé, rien à envoyer.');
  });

  it('renvoie le profil quand le nom, l\'avatar ou la bannière changent', async () => {
    const api = mockApi({});
    const fake = fakeClient();
    create(fake.client);

    await boot();
    fake.setProfile(botUser({ avatar: 'c'.repeat(32) }));
    await vi.advanceTimersByTimeAsync(HOUR);
    fake.setProfile(botUser({ avatar: 'c'.repeat(32), banner: null }));
    await vi.advanceTimersByTimeAsync(HOUR);
    fake.setProfile(botUser({ username: 'Nouveau nom', avatar: 'c'.repeat(32), banner: null }));
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(api.calls('profile')).toHaveLength(4);
    expect(profileBody(api, 3)).toEqual({ bot_id: BOT_ID, username: 'Nouveau nom', avatar: 'c'.repeat(32), banner: null });
  });

  it("un userUpdate du bot renvoie le profil 5 s plus tard, sans attendre l'heure", async () => {
    const api = mockApi({});
    const fake = fakeClient();
    create(fake.client);

    await boot();
    fake.updateUser(botUser({ username: 'Renommé' }));
    // Plusieurs modifications rapprochées ne donnent qu'un envoi.
    await vi.advanceTimersByTimeAsync(2_000);
    fake.updateUser(botUser({ username: 'Renommé', avatar: 'd'.repeat(32) }));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(api.calls('profile')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.calls('profile')).toHaveLength(2);
    expect(profileBody(api, 1)).toMatchObject({ username: 'Renommé', avatar: 'd'.repeat(32) });
  });

  it("ignore les userUpdate d'autres utilisateurs", async () => {
    const api = mockApi({});
    const fake = fakeClient();
    create(fake.client);

    await boot();
    (fake.client as unknown as NodeJS.EventEmitter).emit('userUpdate', { id: '1' }, { id: '999', username: 'Autre' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(profileFetches(fake)).toHaveLength(1);
    expect(api.calls('profile')).toHaveLength(1);
  });

  it("prévient dans la console quand la fiche repasse en vérification", async () => {
    mockApi({ profile: [profileOk({ review_required: true })] });
    create(fakeClient({ profile: botUser({ username: 'Renommé' }) }).client);

    await boot();

    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain(
      'Le nom du bot a changé (Renommé) : sa fiche Bot List repasse en attente de vérification.',
    );
  });

  it("postProfile: false : rien n'est envoyé automatiquement, même après un userUpdate", async () => {
    const api = mockApi({});
    const fake = fakeClient();
    const botlist = create(fake.client, { postProfile: false });

    await boot();
    fake.updateUser(botUser({ username: 'Renommé' }));
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(profileFetches(fake)).toHaveLength(0);
    expect(api.calls('profile')).toHaveLength(0);
    expect(fake.client.listenerCount('userUpdate')).toBe(0);
    expect(botlist.running).toBe(true);
  });

  it('postProfile() envoie immédiatement, même sans changement', async () => {
    const api = mockApi({});
    const botlist = create(fakeClient().client);
    const onProfile = vi.fn();
    botlist.on('profilePosted', onProfile);

    await boot();
    const data = await botlist.postProfile();

    expect(data).toMatchObject({ bot_id: BOT_ID, changed: true });
    expect(api.calls('profile')).toHaveLength(2);
    expect(onProfile).toHaveBeenCalledTimes(2);
  });

  it("postProfile() rejette avec une BotListError en cas d'échec", async () => {
    mockApi({ profile: [jsonResponse(422, { ok: false, error: 'validation_failed', message: 'bad' })] });
    const botlist = create(fakeClient().client, { autoPost: false });

    const error = await botlist.postProfile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BotListError);
    expect(error).toMatchObject({ code: 'validation_failed', status: 422 });
  });

  it("une shard différente de 0 ne récupère ni n'envoie rien", async () => {
    const api = mockApi({});
    const fake = fakeClient({ shard: { ids: [1], count: 2, fetchClientValues: async () => [1, 1] } });
    const botlist = create(fake.client);

    await boot();
    fake.updateUser(botUser({ username: 'Renommé' }));
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(api.fetch).not.toHaveBeenCalled();
    expect(fake.rest.get).not.toHaveBeenCalled();
    await expect(botlist.postProfile()).resolves.toBeNull();
  });

  it('stop() arrête la vérification et retire l\'écouteur userUpdate', async () => {
    const api = mockApi({});
    const fake = fakeClient();
    const botlist = create(fake.client);

    await boot();
    expect(fake.client.listenerCount('userUpdate')).toBe(1);
    botlist.stop();
    expect(fake.client.listenerCount('userUpdate')).toBe(0);

    fake.updateUser(botUser({ username: 'Renommé' }));
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(api.calls('profile')).toHaveLength(1);
  });
});

describe('erreurs sur /profile', () => {
  it('401 sur /profile arrête aussi le signal de vie', async () => {
    const api = mockApi({ profile: [jsonResponse(401, { ok: false, error: 'invalid_token' })] });
    const botlist = create(fakeClient().client);
    const onError = vi.fn();
    botlist.on('error', onError);

    await boot();
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(botlist.running).toBe(false);
    expect(api.calls('push')).toHaveLength(1);
    expect(api.calls('profile')).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'invalid_token', status: 401 });
  });

  it("un 5xx sur /profile n'affecte pas /push", async () => {
    const api = mockApi({ profile: [jsonResponse(503, { message: 'down' })] });
    const botlist = create(fakeClient().client);
    const onError = vi.fn();
    botlist.on('error', onError);

    await boot();
    await vi.advanceTimersByTimeAsync(900_000);

    expect(api.calls('push')).toHaveLength(4);
    expect(api.calls('profile').length).toBeGreaterThanOrEqual(4);
    expect(onError.mock.calls.every(([error]) => error.code === 'server_error')).toBe(true);
    expect(botlist.running).toBe(true);
  });

  it("une route absente (404) est réessayée à l'heure suivante sans gêner le signal de vie", async () => {
    const api = mockApi({ profile: [jsonResponse(404, { ok: false, message: 'Not found' })] });
    const botlist = create(fakeClient().client);
    const onError = vi.fn();
    botlist.on('error', onError);

    await boot();
    await vi.advanceTimersByTimeAsync(HOUR - 1_000);
    expect(api.calls('profile')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.calls('profile')).toHaveLength(2);

    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'http_error', status: 404 });
    expect(api.calls('push').length).toBeGreaterThanOrEqual(12);
    expect(botlist.running).toBe(true);
  });

  it('une erreur Discord à la récupération émet profile_fetch_failed sans casser le signal de vie', async () => {
    const api = mockApi({});
    const fake = fakeClient();
    fake.rest.get.mockRejectedValue(new Error('Missing Access'));
    const botlist = create(fake.client);
    const onError = vi.fn();
    botlist.on('error', onError);

    await boot();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'profile_fetch_failed' });
    expect(api.calls('profile')).toHaveLength(0);
    expect(api.calls('push')).toHaveLength(3);
  });
});
