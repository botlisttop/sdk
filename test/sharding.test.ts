import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotListClient, type BotListClientOptions } from '../src/index.js';
import { TOKEN, fakeClient, flush, mockFetch, ok, sentBody } from './helpers.js';

const instances: BotListClient[] = [];
// Les commandes slash sont testées dans commands.test.ts.
function create(client: BotListClient['client'], options: BotListClientOptions) {
  const botlist = new BotListClient(client, { postCommands: false, postProfile: false, ...options });
  instances.push(botlist);
  return botlist;
}

function shardedClient(ids: number[], count: number, fetchClientValues: (prop: string) => Promise<unknown[]>) {
  return fakeClient({ shard: { ids, count, fetchClientValues } }).client;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const botlist of instances.splice(0)) botlist.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sharding', () => {
  it('additionne les serveurs de toutes les shards et envoie shard_count', async () => {
    const fetchMock = mockFetch(ok());
    const fetchClientValues = vi.fn(async () => [120, 98, 143]);
    create(shardedClient([0], 3, fetchClientValues), { token: TOKEN });

    await flush();

    expect(fetchClientValues).toHaveBeenCalledWith('guilds.cache.size');
    expect(sentBody(fetchMock)).toMatchObject({ server_count: 361, shard_count: 3 });
  });

  it("une shard différente de 0 n'envoie jamais rien", async () => {
    const fetchMock = mockFetch(ok());
    const fetchClientValues = vi.fn(async () => [1, 2]);
    const botlist = create(shardedClient([1], 2, fetchClientValues), { token: TOKEN });

    await flush();
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchClientValues).not.toHaveBeenCalled();
    expect(botlist.running).toBe(false);
    await expect(botlist.postStats()).resolves.toBeNull();
  });

  it('un process qui gère la shard 0 parmi plusieurs envoie', async () => {
    const fetchMock = mockFetch(ok());
    create(shardedClient([0, 1], 4, async () => [5, 5, 5, 5]), { token: TOKEN });
    await flush();
    expect(sentBody(fetchMock)).toMatchObject({ server_count: 20, shard_count: 4 });
  });

  it('réessaie si les shards ne sont pas encore toutes prêtes', async () => {
    const fetchMock = mockFetch(ok());
    const fetchClientValues = vi
      .fn<(prop: string) => Promise<unknown[]>>()
      .mockRejectedValueOnce(new Error('Shards are still being spawned.'))
      .mockResolvedValue([10, 20]);
    const botlist = create(shardedClient([0], 2, fetchClientValues), { token: TOKEN });
    const onError = vi.fn();
    botlist.on('error', onError);

    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sentBody(fetchMock)).toMatchObject({ server_count: 30, shard_count: 2 });
  });

  it('sans sharding : guilds.cache.size et shard_count = 1', async () => {
    const fetchMock = mockFetch(ok());
    create(fakeClient({ guilds: 7 }).client, { token: TOKEN });
    await flush();
    expect(sentBody(fetchMock)).toMatchObject({ server_count: 7, shard_count: 1 });
  });
});
