/** Codes d'erreur renvoyés par l'API ou générés par le SDK. */
export type BotListErrorCode =
  | 'missing_token'
  | 'invalid_token'
  | 'bot_mismatch'
  | 'owner_banned'
  | 'forbidden'
  | 'validation_failed'
  | 'rate_limited'
  | 'server_error'
  | 'http_error'
  | 'network_error'
  | 'timeout'
  | 'invalid_response'
  | 'client_not_ready'
  | 'shards_not_ready';

export interface BotListErrorOptions {
  code: BotListErrorCode;
  message: string;
  /** Code HTTP de la réponse, absent pour les erreurs réseau ou locales. */
  status?: number;
  /** Délai d'attente imposé par l'API (429), en secondes. */
  retryAfter?: number;
  /** Détail des champs invalides (422). */
  errors?: Record<string, unknown>;
  cause?: unknown;
}

export class BotListError extends Error {
  readonly code: BotListErrorCode;
  readonly status: number | undefined;
  readonly retryAfter: number | undefined;
  readonly errors: Record<string, unknown> | undefined;

  constructor(options: BotListErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BotListError';
    this.code = options.code;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
    this.errors = options.errors;
  }

  /** Clé refusée (401 / 403) : inutile de réessayer avec la même clé. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403 || this.code === 'missing_token';
  }

  /** Erreur temporaire (5xx, réseau, délai dépassé) : le SDK réessaie avec un délai croissant. */
  get isTemporary(): boolean {
    return (
      this.code === 'server_error' ||
      this.code === 'network_error' ||
      this.code === 'timeout' ||
      this.code === 'invalid_response'
    );
  }
}

const DASHBOARD_HINT = 'Dashboard Bot List > fiche du bot > API développeur';

/** Messages en français expliquant quoi faire, par code d'erreur. */
export function describeError(code: BotListErrorCode, context: { botId?: string; status?: number } = {}): string {
  switch (code) {
    case 'missing_token':
      return `Aucune clé API Bot List fournie. Générez-la dans le ${DASHBOARD_HINT}, placez-la dans votre fichier .env (BOTLIST_TOKEN=...) et passez-la dans l'option "token". L'envoi automatique est arrêté.`;
    case 'invalid_token':
      return `Clé API Bot List invalide. Elle a peut-être été régénérée ou mal copiée : générez une nouvelle clé dans le ${DASHBOARD_HINT} et mettez à jour votre fichier .env. L'envoi automatique est arrêté.`;
    case 'bot_mismatch':
      return `Cette clé API appartient à un autre bot que ${context.botId ?? 'celui connecté'}. Vérifiez que le bot connecté est bien celui de la fiche Bot List, ou utilisez la clé de ce bot (${DASHBOARD_HINT}). L'envoi automatique est arrêté.`;
    case 'owner_banned':
      return "Le propriétaire de ce bot est banni de Bot List : les statistiques ne peuvent plus être envoyées. Contactez l'équipe Bot List si vous pensez qu'il s'agit d'une erreur. L'envoi automatique est arrêté.";
    case 'forbidden':
      return `Bot List refuse l'envoi des statistiques pour ce bot. Vérifiez que le bot est bien enregistré sur Bot List et que la clé est la sienne (${DASHBOARD_HINT}). L'envoi automatique est arrêté.`;
    case 'validation_failed':
      return "Bot List a refusé les données envoyées (validation échouée). Nouvel essai au prochain cycle.";
    case 'rate_limited':
      return "Trop de requêtes vers Bot List (limite : 10 par minute et par bot). Le SDK attend avant de reprendre.";
    case 'server_error':
      return `Bot List est temporairement indisponible (HTTP ${context.status ?? '5xx'}). Le SDK réessaiera automatiquement.`;
    case 'http_error':
      return `Réponse inattendue de Bot List (HTTP ${context.status ?? '?'}).`;
    case 'network_error':
      return "Impossible de joindre Bot List (erreur réseau). Le SDK réessaiera automatiquement.";
    case 'timeout':
      return "Bot List n'a pas répondu dans les 10 secondes. Le SDK réessaiera automatiquement.";
    case 'invalid_response':
      return "Bot List a renvoyé une réponse illisible. Le SDK réessaiera automatiquement.";
    case 'client_not_ready':
      return "Le client Discord n'est pas encore connecté : attendez l'événement \"clientReady\" avant d'appeler postStats().";
    case 'shards_not_ready':
      return "Toutes les shards ne sont pas encore prêtes : impossible de compter les serveurs. Nouvel essai sous peu.";
  }
}
