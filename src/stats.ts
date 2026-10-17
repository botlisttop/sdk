import type { Client } from 'discord.js';
import { BotListError, describeError } from './errors.js';

export interface CollectedStats {
  serverCount: number;
  shardCount: number;
}

/**
 * Indique si ce process doit envoyer les statistiques. Avec un ShardingManager,
 * seule la shard 0 envoie, pour le compte de toutes les autres.
 */
export function isPrimaryShard(client: Client): boolean {
  return !client.shard || client.shard.ids.includes(0);
}

/** Compte les serveurs de toutes les shards. */
export async function collectStats(client: Client): Promise<CollectedStats> {
  if (client.shard) {
    let values: unknown[];
    try {
      values = await client.shard.fetchClientValues('guilds.cache.size');
    } catch (cause) {
      throw new BotListError({ code: 'shards_not_ready', message: describeError('shards_not_ready'), cause });
    }
    const serverCount = values.reduce<number>((total, value) => total + (Number(value) || 0), 0);
    return { serverCount, shardCount: Math.max(1, client.shard.count) };
  }

  // Sans ShardingManager, un même process peut gérer plusieurs shards internes.
  return { serverCount: client.guilds.cache.size, shardCount: Math.max(1, client.ws?.shards?.size ?? 1) };
}
