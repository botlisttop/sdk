import type { Client } from 'discord.js';
import { BotListError, describeError } from './errors.js';

/** Profil public du bot, tel qu'affiché sur sa fiche Bot List. */
export interface BotProfile {
  username: string;
  /** Hash de l'avatar Discord, `null` pour l'avatar par défaut. */
  avatar: string | null;
  /** Hash de la bannière Discord, `null` sans bannière. */
  banner: string | null;
}

/** Route du compte connecté, identique à `Routes.user()` de discord.js. */
export const CURRENT_USER_ROUTE = '/users/@me';

/**
 * Récupère le nom, l'avatar et la bannière du bot auprès de Discord. La bannière
 * n'est pas toujours présente dans le cache de discord.js : on passe donc par l'API.
 */
export async function fetchBotProfile(client: Client): Promise<BotProfile> {
  if (!client.user?.id) {
    throw new BotListError({ code: 'client_not_ready', message: describeError('client_not_ready') });
  }

  let user: unknown;
  try {
    user = await client.rest.get(CURRENT_USER_ROUTE);
  } catch (cause) {
    throw new BotListError({ code: 'profile_fetch_failed', message: describeError('profile_fetch_failed'), cause });
  }

  if (!isRecord(user) || typeof user.username !== 'string') {
    throw new BotListError({ code: 'profile_fetch_failed', message: describeError('profile_fetch_failed') });
  }
  return { username: user.username, avatar: hashOrNull(user.avatar), banner: hashOrNull(user.banner) };
}

/** Clé de comparaison, pour ne renvoyer le profil que lorsqu'il change. */
export function profileKey(profile: BotProfile): string {
  return JSON.stringify([profile.username, profile.avatar, profile.banner]);
}

function hashOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
