import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotListClient, BotListError, SDK_VERSION, type BotListClientOptions } from '../src/index.js';
import { BOT_ID, TOKEN, fakeClient, flush, jsonResponse, mockFetch, ok, sentBody } from './helpers.js';

const instances: BotListClient[] = [];
// Les commandes slash sont testées dans commands.test.ts.
function create(client: BotListClient['client'], options: BotListClientOptions) {
  const botlist = new BotListClient(client, { postCommands: false, postProfile: false, ...options });
  instances.push(botlist);
  return botlist;
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

describe('envoi réussi', () => {
  it('envoie dès que le client est prêt, avec les bons en-têtes et le bon corps', async () => {
    const fetchMock = mockFetch(ok());
    const botlist = create(fakeClient({ guilds: 42 }).client, { token: TOKEN });
    const posted = vi.fn();
    botlist.on('posted', posted);

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://botlist.top/api/sdk/push');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `BotListSDK/${SDK_VERSION} (+https://botlist.top)`,
    });
    expect(sentBody(fetchMock)).toEqual({ bot_id: BOT_ID, server_count: 42, shard_count: 1, sdk_version: SDK_VERSION });
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ online: true, next_push_in: 300 }));
  });

  it("attend l'événement clientReady si le client n'est pas encore connecté", async () => {
    const fetchMock = mockFetch(ok());
    const fake = fakeClient({ ready: false });
    create(fake.client, { token: TOKEN });

    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    fake.setReady();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repousse toutes les next_push_in secondes et suit la valeur renvoyée par l'API", async () => {
    const fetchMock = mockFetch(ok({ next_push_in: 120 }));
    create(fakeClient().client, { token: TOKEN });

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('plafonne un interval fixe à 840 s avec un avertissement', async () => {
    const fetchMock = mockFetch(ok());
    create(fakeClient().client, { token: TOKEN, interval: 3600 });
    expect(console.warn).toHaveBeenCalled();

    await flush();
    await vi.advanceTimersByTimeAsync(840_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('impose un interval minimum de 60 s', async () => {
    const fetchMock = mockFetch(ok());
    create(fakeClient().client, { token: TOKEN, interval: 5 });

    await flush();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("n'envoie rien automatiquement avec autoPost: false, mais postStats() fonctionne", async () => {
    const fetchMock = mockFetch(ok());
    const botlist = create(fakeClient().client, { token: TOKEN, autoPost: false });

    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    const data = await botlist.postStats();
    expect(data?.server_count).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stop() arrête les envois', async () => {
    const fetchMock = mockFetch(ok());
    const botlist = create(fakeClient().client, { token: TOKEN });
    await flush();
    botlist.stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(botlist.running).toBe(false);
  });

  it('accepte un baseUrl personnalisé', async () => {
    const fetchMock = mockFetch(ok());
    create(fakeClient().client, { token: TOKEN, baseUrl: 'http://localhost:8000/' });
    await flush();
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8000/api/sdk/push');
  });
});

describe('clé refusée (401 / 403)', () => {
  it("401 arrête l'envoi automatique et émet une erreur explicite", async () => {
    const fetchMock = mockFetch(jsonResponse(401, { ok: false, error: 'invalid_token', message: 'Invalid token' }));
    const botlist = create(fakeClient().client, { token: TOKEN });
    const onError = vi.fn();
    botlist.on('error', onError);

    await flush();
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(botlist.running).toBe(false);
    const error = onError.mock.calls[0]![0] as BotListError;
    expect(error).toBeInstanceOf(BotListError);
    expect(error.code).toBe('invalid_token');
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/dashboard/i);
  });

  it("403 bot_mismatch arrête l'envoi automatique", async () => {
    mockFetch(jsonResponse(403, { ok: false, error: 'bot_mismatch', message: 'Mismatch' }));
    const botlist = create(fakeClient().client, { token: TOKEN });
    const onError = vi.fn();
    botlist.on('error', onError);

    await flush();

    expect(botlist.running).toBe(false);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'bot_mismatch', status: 403 });
  });

  it("postStats() rejette et arrête aussi l'envoi automatique", async () => {
    mockFetch(jsonResponse(401, { ok: false, error: 'invalid_token' }));
    const botlist = create(fakeClient().client, { token: TOKEN, autoPost: false });
    botlist.start();
    await expect(botlist.postStats()).rejects.toMatchObject({ code: 'invalid_token' });
    expect(botlist.running).toBe(false);
  });

  it("sans clé : aucune requête, une erreur missing_token, et pas d'exception", async () => {
    const fetchMock = mockFetch(ok());
    const botlist = create(fakeClient().client, { token: undefined as unknown as string });
    const onError = vi.fn();
    botlist.on('error', onError);

    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'missing_token' });
  });
});

describe('limite de requêtes (429)', () => {
  it('émet ratelimited, attend retry_after puis reprend', async () => {
    const fetchMock = mockFetch(jsonResponse(429, { ok: false, error: 'rate_limited', retry_after: 42 }), ok());
    const botlist = create(fakeClient().client, { token: TOKEN });
    const onRateLimited = vi.fn();
    botlist.on('ratelimited', onRateLimited);

    await flush();
    expect(onRateLimited).toHaveBeenCalledWith(42);

    await vi.advanceTimersByTimeAsync(41_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(botlist.running).toBe(true);
  });

  it("utilise l'en-tête Retry-After si le corps ne le donne pas", async () => {
    mockFetch(jsonResponse(429, { ok: false }, { 'Retry-After': '17' }), ok());
    const botlist = create(fakeClient().client, { token: TOKEN });
    const onRateLimited = vi.fn();
    botlist.on('ratelimited', onRateLimited);
    await flush();
    expect(onRateLimited).toHaveBeenCalledWith(17);
  });
});

describe('erreurs temporaires (5xx, réseau)', () => {
  it('réessaie avec un délai croissant : 30 s, 60 s, 120 s, 240 s, plafonné à 300 s', async () => {
    const fetchMock = mockFetch(jsonResponse(503, { message: 'down' }));
    const botlist = create(fakeClient().client, { token: TOKEN });
    const onError = vi.fn();
    botlist.on('error', onError);

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const expectedDelays = [30, 60, 120, 240, 300, 300];
    for (const [i, delay] of expectedDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay * 1000 - 1);
      expect(fetchMock).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(i + 2);
    }
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'server_error', status: 503 });
    expect(botlist.running).toBe(true);
  });

  it('remet le délai à zéro après un succès', async () => {
    const fetchMock = mockFetch(new TypeError('fetch failed'), new TypeError('fetch failed'), ok());
    const botlist = create(fakeClient().client, { token: TOKEN });
    const onError = vi.fn();
    botlist.on('error', onError);

    await flush(); // échec 1
    await vi.advanceTimersByTimeAsync(30_000); // échec 2
    await vi.advanceTimersByTimeAsync(60_000); // succès
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'network_error' });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('une réponse non JSON (page Cloudflare) est traitée comme temporaire', async () => {
    mockFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    const botlist = create(fakeClient().client, { token: TOKEN });
    const onError = vi.fn();
    botlist.on('error', onError);
    await flush();
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'server_error', status: 502 });
  });

  it('abandonne la requête après 10 s (timeout)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );
    const botlist = create(fakeClient().client, { token: TOKEN });
    const onError = vi.fn();
    botlist.on('error', onError);

    await flush();
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'timeout' });
  });
});

describe('validation (422)', () => {
  it('émet une erreur et continue au cycle suivant', async () => {
    const fetchMock = mockFetch(
      jsonResponse(422, {
        ok: false,
        error: 'validation_failed',
        message: 'Invalid data',
        errors: { server_count: ['must be >= 0'] },
      }),
    );
    const botlist = create(fakeClient().client, { token: TOKEN });
    const onError = vi.fn();
    botlist.on('error', onError);

    await flush();
    const error = onError.mock.calls[0]![0] as BotListError;
    expect(error.code).toBe('validation_failed');
    expect(error.errors).toEqual({ server_count: ['must be >= 0'] });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(botlist.running).toBe(true);
  });
});

describe('robustesse', () => {
  it("sans écouteur 'error', ne lève rien et logge l'erreur", async () => {
    mockFetch(jsonResponse(401, { ok: false, error: 'invalid_token' }));
    create(fakeClient().client, { token: TOKEN });
    await flush();
    expect(console.error).toHaveBeenCalled();
  });

  it('un écouteur qui lève une exception ne casse pas la boucle', async () => {
    const fetchMock = mockFetch(ok());
    const botlist = create(fakeClient().client, { token: TOKEN });
    botlist.on('posted', () => {
      throw new Error('bug utilisateur');
    });
    await flush();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ne logge jamais la clé, même en mode debug', async () => {
    mockFetch(jsonResponse(401, { ok: false, error: 'invalid_token' }));
    create(fakeClient().client, { token: TOKEN, debug: true, interval: 1 });
    await flush();

    const output = [console.log, console.warn, console.error]
      .flatMap((fn) => vi.mocked(fn).mock.calls.flat())
      .map(String)
      .join('\n');
    expect(output).toContain('blt_****');
    expect(output).not.toContain(TOKEN);
  });

  it('le timer ne retient pas le process (unref)', () => {
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      timer.unref = unref.mockReturnValue(timer);
      return timer;
    }) as unknown as typeof setTimeout);
    mockFetch(ok());
    const botlist = create(fakeClient().client, { token: TOKEN, autoPost: false });
    botlist.start();
    expect(unref).toHaveBeenCalled();
  });
});
