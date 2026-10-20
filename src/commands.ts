import { createHash } from 'node:crypto';
import type { Client } from 'discord.js';
import { BotListError, describeError } from './errors.js';

type RawCommand = Record<string, unknown>;

/** Champs conservés par Bot List : les autres (id, version...) sont retirés avant l'envoi. */
const COMMAND_FIELDS = ['type', 'name', 'description', 'name_localizations', 'description_localizations', 'nsfw', 'options'];
const OPTION_FIELDS = [
  'type',
  'name',
  'description',
  'name_localizations',
  'description_localizations',
  'required',
  'choices',
  'options',
];
const LOCALIZATION_FIELDS = new Set(['name_localizations', 'description_localizations']);

/** Route des commandes globales, identique à `Routes.applicationCommands()` de discord.js. */
export function applicationCommandsRoute(applicationId: string): `/${string}` {
  return `/applications/${applicationId}/commands`;
}

/**
 * Récupère les commandes slash GLOBALES du bot au format brut de l'API Discord,
 * avec leurs localisations. Les commandes de serveur ne sont jamais récupérées.
 */
export async function fetchGlobalCommands(client: Client): Promise<RawCommand[]> {
  const applicationId = client.application?.id ?? client.user?.id;
  if (!applicationId) {
    throw new BotListError({ code: 'client_not_ready', message: describeError('client_not_ready') });
  }

  let commands: unknown;
  try {
    commands = await client.rest.get(applicationCommandsRoute(applicationId), {
      // Sans ce paramètre, Discord ne renvoie pas les dictionnaires de localisation.
      query: new URLSearchParams({ with_localizations: 'true' }),
    });
  } catch (cause) {
    throw new BotListError({ code: 'commands_fetch_failed', message: describeError('commands_fetch_failed'), cause });
  }

  if (!Array.isArray(commands)) {
    throw new BotListError({ code: 'commands_fetch_failed', message: describeError('commands_fetch_failed') });
  }
  return commands.filter(isRecord);
}

/** Ne garde que les champs utiles à Bot List et trie les commandes par type puis par nom. */
export function prepareCommands(commands: RawCommand[]): RawCommand[] {
  return commands
    .map((command) => pick(command, COMMAND_FIELDS))
    .sort((a, b) => commandType(a) - commandType(b) || compare(String(a.name), String(b.name)));
}

/** Empreinte de la liste préparée, pour ne renvoyer que lorsqu'elle change. */
export function hashCommands(commands: RawCommand[]): string {
  return createHash('sha1').update(JSON.stringify(commands)).digest('hex');
}

function pick(source: RawCommand, fields: string[]): RawCommand {
  const result: RawCommand = {};
  for (const field of fields) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (field === 'options' && Array.isArray(value)) {
      result.options = value.filter(isRecord).map((option) => pick(option, OPTION_FIELDS));
    } else if (field === 'choices' && Array.isArray(value)) {
      result.choices = value.filter(isRecord).map((choice) => ({ name: choice.name }));
    } else if (LOCALIZATION_FIELDS.has(field) && isRecord(value)) {
      // Clés triées pour que l'empreinte ne dépende pas de l'ordre renvoyé par Discord.
      result[field] = Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)));
    } else {
      result[field] = value;
    }
  }
  return result;
}

/** Comparaison indépendante de la langue du système, pour une empreinte stable. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function commandType(command: RawCommand): number {
  return typeof command.type === 'number' ? command.type : 1;
}

function isRecord(value: unknown): value is RawCommand {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
