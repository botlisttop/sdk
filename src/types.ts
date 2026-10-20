import type { BotListError } from './errors.js';

export interface BotListClientOptions {
  /** Clé API du bot (format `blt_...`), générée dans le dashboard Bot List. */
  token: string;
  /** Envoie automatiquement les statistiques (défaut : `true`). */
  autoPost?: boolean;
  /**
   * Intervalle entre deux envois, en secondes. Par défaut, le SDK suit la valeur
   * `next_push_in` renvoyée par l'API (300 s). Borné entre 60 et 840 s.
   */
  interval?: number;
  /** URL de l'API Bot List (défaut : `https://beta.botlist.top`). */
  baseUrl?: string;
  /** Affiche des logs de diagnostic dans la console (défaut : `false`). */
  debug?: boolean;
  /**
   * Envoie automatiquement les commandes slash globales du bot, affichées dans
   * l'onglet « Commandes » de sa fiche (défaut : `true`).
   */
  postCommands?: boolean;
}

/** Corps envoyé à `POST /api/sdk/push`. */
export interface PushPayload {
  bot_id: string;
  server_count: number;
  shard_count?: number;
  sdk_version?: string;
}

/** Données renvoyées par l'API après un envoi réussi. */
export interface PushData {
  bot_id: string;
  server_count: number;
  shard_count: number | null;
  online: boolean;
  /** Date de réception (ISO 8601). */
  received_at: string;
  /** Délai conseillé avant le prochain envoi, en secondes. */
  next_push_in: number;
  /** Durée pendant laquelle le bot reste « En ligne » sans nouvel envoi, en secondes. */
  online_window: number;
}

/** Corps envoyé à `POST /api/sdk/commands`. */
export interface CommandsPayload {
  bot_id: string;
  /** Commandes globales au format de l'API Discord (snake_case). */
  commands: Record<string, unknown>[];
}

/** Données renvoyées par l'API après un envoi de commandes réussi. */
export interface CommandsData {
  bot_id: string;
  commands_count: number;
  /** `false` si la liste était identique à celle déjà enregistrée. */
  changed: boolean;
  /** Date de réception (ISO 8601). */
  received_at: string;
}

/** Événements émis par `BotListClient`. */
export interface BotListEvents {
  posted: [data: PushData];
  commandsPosted: [data: CommandsData];
  error: [error: BotListError];
  ratelimited: [retryAfter: number];
}
