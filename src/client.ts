import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { BotListError, describeError } from './errors.js';
import { fetchGlobalCommands, hashCommands, prepareCommands } from './commands.js';
import { pushCommands, pushProfile, pushStats } from './http.js';
import { Logger, maskToken } from './logger.js';
import { fetchBotProfile, profileKey, type BotProfile } from './profile.js';
import { collectStats, isPrimaryShard } from './stats.js';
import type { BotListClientOptions, BotListEvents, CommandsData, ProfileData, PushData } from './types.js';
import { SDK_VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://botlist.top';
/** Intervalle par défaut tant que l'API n'a pas donné `next_push_in`, en secondes. */
export const DEFAULT_INTERVAL = 300;
export const MIN_INTERVAL = 60;
/** Au-delà de 15 min sans envoi, le bot passe « Hors ligne » : on garde une marge. */
export const MAX_INTERVAL = 840;
/** Premier délai de nouvel essai après une erreur temporaire, en secondes. */
export const BACKOFF_BASE = 30;
/** Délai entre deux vérifications des commandes slash, en secondes. */
export const COMMANDS_INTERVAL = 3600;
/** Délai entre deux vérifications du profil (nom, avatar, bannière), en secondes. */
export const PROFILE_INTERVAL = 3600;
/** Attente après un `userUpdate`, pour regrouper plusieurs modifications rapprochées. */
const PROFILE_UPDATE_DELAY_MS = 5_000;
const READY_POLL_MS = 2_000;

/** Envois secondaires, chacun avec son propre minuteur : ils ne retardent jamais le signal de vie. */
type SyncKind = 'commands' | 'profile';

const SYNC_INTERVALS: Record<SyncKind, number> = { commands: COMMANDS_INTERVAL, profile: PROFILE_INTERVAL };
const SYNC_LABELS: Record<SyncKind, string> = { commands: 'commandes', profile: 'profil' };

interface SyncState {
  timer: NodeJS.Timeout | null;
  failures: number;
}

type Listener<E extends keyof BotListEvents> = (...args: BotListEvents[E]) => void;

export interface BotListClient {
  on<E extends keyof BotListEvents>(event: E, listener: Listener<E>): this;
  once<E extends keyof BotListEvents>(event: E, listener: Listener<E>): this;
  off<E extends keyof BotListEvents>(event: E, listener: Listener<E>): this;
  addListener<E extends keyof BotListEvents>(event: E, listener: Listener<E>): this;
  removeListener<E extends keyof BotListEvents>(event: E, listener: Listener<E>): this;
  emit<E extends keyof BotListEvents>(event: E, ...args: BotListEvents[E]): boolean;
}

/**
 * Envoie automatiquement à Bot List le nombre de serveurs du bot, un signal de vie,
 * ses commandes slash globales et son profil (nom, avatar, bannière).
 *
 * ```js
 * const botlist = new BotListClient(client, { token: process.env.BOTLIST_TOKEN });
 * ```
 */
export class BotListClient extends EventEmitter {
  /** Client discord.js surveillé. */
  readonly client: Client;
  readonly baseUrl: string;

  readonly #token: string;
  readonly #fixedInterval: number | null;
  readonly #logger: Logger;
  readonly #autoCommands: boolean;
  readonly #autoProfile: boolean;

  #running = false;
  #timer: NodeJS.Timeout | null = null;
  #readyPoll: NodeJS.Timeout | null = null;
  #readyListener: (() => void) | null = null;
  #apiInterval = DEFAULT_INTERVAL;
  #failures = 0;

  readonly #sync: Record<SyncKind, SyncState> = {
    commands: { timer: null, failures: 0 },
    profile: { timer: null, failures: 0 },
  };
  /** `true` une fois les envois secondaires lancés, après le premier signal de vie réussi. */
  #syncStarted = false;
  #userUpdateListener: ((oldUser: unknown, newUser: unknown) => void) | null = null;

  /** Empreinte de la dernière liste envoyée avec succès. */
  #sentCommandsHash: string | null = null;
  /** Empreinte d'une liste refusée car trop volumineuse (413) : pas de renvoi tant qu'elle ne change pas. */
  #rejectedCommandsHash: string | null = null;
  /** Dernier profil envoyé avec succès. */
  #sentProfileKey: string | null = null;

  constructor(client: Client, options: BotListClientOptions) {
    super();
    if (!client || typeof client !== 'object') {
      throw new TypeError('BotListClient : le premier argument doit être votre client discord.js.');
    }

    this.client = client;
    this.#logger = new Logger(options?.debug === true);
    this.#token = typeof options?.token === 'string' ? options.token.trim() : '';
    this.baseUrl = (options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#fixedInterval = this.#resolveInterval(options?.interval);
    this.#autoCommands = options?.postCommands !== false;
    this.#autoProfile = options?.postProfile !== false;

    this.#logger.debug(
      `SDK ${SDK_VERSION} initialisé (clé : ${maskToken(this.#token)}, intervalle : ${
        this.#fixedInterval === null ? 'automatique' : `${this.#fixedInterval} s`
      }, API : ${this.baseUrl}).`,
    );

    if (options?.autoPost !== false) this.start();
  }

  /** `true` si l'envoi automatique est actif. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * Envoie les statistiques maintenant. Renvoie la réponse de l'API, ou `null` si
   * ce process n'est pas la shard 0 (c'est elle qui envoie pour toutes les shards).
   * Rejette avec une `BotListError` en cas d'échec.
   */
  async postStats(): Promise<PushData | null> {
    const botId = this.#primaryBotId();
    if (botId === null) return null;

    const stats = await collectStats(this.client);

    let data: PushData;
    try {
      data = await pushStats({
        baseUrl: this.baseUrl,
        token: this.#token,
        payload: {
          bot_id: botId,
          server_count: stats.serverCount,
          shard_count: stats.shardCount,
          sdk_version: SDK_VERSION.slice(0, 32),
        },
      });
    } catch (error) {
      const botListError = toBotListError(error);
      // Une clé refusée le restera : inutile de continuer à envoyer.
      if (botListError.isAuthError) this.stop();
      throw botListError;
    }

    if (typeof data.next_push_in === 'number' && data.next_push_in > 0) {
      this.#apiInterval = data.next_push_in;
    }
    this.#logger.debug(`Statistiques envoyées : ${stats.serverCount} serveur(s), ${stats.shardCount} shard(s).`);
    this.#safeEmit('posted', data);
    return data;
  }

  /**
   * Récupère les commandes slash globales du bot et les envoie maintenant, même si
   * elles n'ont pas changé. Renvoie la réponse de l'API, ou `null` si ce process
   * n'est pas la shard 0. Rejette avec une `BotListError` en cas d'échec.
   */
  async postCommands(): Promise<CommandsData | null> {
    const botId = this.#primaryBotId();
    if (botId === null) return null;

    const commands = prepareCommands(await fetchGlobalCommands(this.client));
    return this.#sendCommands(botId, commands, hashCommands(commands));
  }

  /**
   * Récupère le nom, l'avatar et la bannière du bot et les envoie maintenant, même
   * s'ils n'ont pas changé. Renvoie la réponse de l'API, ou `null` si ce process
   * n'est pas la shard 0. Rejette avec une `BotListError` en cas d'échec.
   */
  async postProfile(): Promise<ProfileData | null> {
    const botId = this.#primaryBotId();
    if (botId === null) return null;

    return this.#sendProfile(botId, await fetchBotProfile(this.client));
  }

  /** Démarre l'envoi automatique (appelé par le constructeur si `autoPost` vaut `true`). */
  start(): void {
    if (this.#running) return;

    if (!this.#token) {
      // Différé pour laisser le temps d'attacher un écouteur 'error'.
      setImmediate(() =>
        this.#emitError(new BotListError({ code: 'missing_token', message: describeError('missing_token') })),
      );
      return;
    }

    if (!isPrimaryShard(this.client)) {
      this.#logger.debug(`Shard ${this.client.shard?.ids.join(', ')} : l'envoi est assuré par la shard 0.`);
      return;
    }

    this.#running = true;
    this.#failures = 0;
    if (this.#autoProfile) this.#watchUserUpdates();

    if (this.#isClientReady()) {
      this.#schedule(0);
    } else {
      this.#logger.debug('En attente de la connexion du client Discord...');
      this.#waitForReady();
    }
  }

  /** Arrête l'envoi automatique. Le bot apparaîtra « Hors ligne » après 15 minutes. */
  stop(): void {
    if (this.#running) this.#logger.debug('Envoi automatique arrêté.');
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const state of Object.values(this.#sync)) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
    this.#syncStarted = false;
    this.#clearReadyWatch();
    if (this.#userUpdateListener) {
      (this.client as unknown as EventEmitter).off('userUpdate', this.#userUpdateListener);
      this.#userUpdateListener = null;
    }
  }

  /** Renvoie l'ID du bot, `null` hors de la shard 0, ou lève une erreur si l'envoi est impossible. */
  #primaryBotId(): string | null {
    if (!this.#token) {
      this.stop();
      throw new BotListError({ code: 'missing_token', message: describeError('missing_token') });
    }
    if (!isPrimaryShard(this.client)) return null;

    const botId = this.client.user?.id;
    if (!botId) {
      throw new BotListError({ code: 'client_not_ready', message: describeError('client_not_ready') });
    }
    return botId;
  }

  async #tick(): Promise<void> {
    this.#timer = null;
    if (!this.#running) return;

    let delay: number | null;
    try {
      await this.postStats();
      this.#failures = 0;
      delay = this.#normalInterval();
      // Commandes et profil partent une première fois juste après le premier signal réussi.
      if (!this.#syncStarted) {
        this.#syncStarted = true;
        if (this.#autoCommands) this.#scheduleSync('commands', 0);
        if (this.#autoProfile) this.#scheduleSync('profile', 0);
      }
    } catch (error) {
      delay = this.#handleCycleError(toBotListError(error));
    }

    if (this.#running && delay !== null) {
      this.#logger.debug(`Prochain envoi dans ${delay} s.`);
      this.#schedule(delay * 1000);
    }
  }

  /** Renvoie le délai avant le prochain essai, en secondes, ou `null` pour arrêter. */
  #handleCycleError(error: BotListError): number | null {
    if (error.isAuthError) {
      this.stop();
      this.#emitError(error);
      return null;
    }

    if (error.code === 'rate_limited') {
      const retryAfter = Math.max(1, error.retryAfter ?? MIN_INTERVAL);
      this.#logger.debug(`Limite de requêtes atteinte, reprise dans ${retryAfter} s.`);
      this.#safeEmit('ratelimited', retryAfter);
      return retryAfter;
    }

    if (error.code === 'shards_not_ready' || error.code === 'client_not_ready') {
      this.#logger.debug(error.message);
      return this.#backoff();
    }

    this.#emitError(error);
    return error.isTemporary ? this.#backoff() : this.#normalInterval();
  }

  /** 30 s, 60 s, 120 s... plafonné à l'intervalle normal. */
  #backoff(): number {
    this.#failures += 1;
    return backoffDelay(this.#failures, this.#normalInterval());
  }

  async #sendCommands(botId: string, commands: Record<string, unknown>[], hash: string): Promise<CommandsData> {
    let data: CommandsData;
    try {
      data = await pushCommands({ baseUrl: this.baseUrl, token: this.#token, payload: { bot_id: botId, commands } });
    } catch (error) {
      const botListError = toBotListError(error);
      if (botListError.isAuthError) this.stop();
      if (botListError.code === 'payload_too_large') this.#rejectedCommandsHash = hash;
      throw botListError;
    }

    this.#sentCommandsHash = hash;
    this.#rejectedCommandsHash = null;
    this.#logger.debug(`Commandes envoyées : ${commands.length} commande(s).`);
    this.#safeEmit('commandsPosted', data);
    return data;
  }

  async #sendProfile(botId: string, profile: BotProfile): Promise<ProfileData> {
    let data: ProfileData;
    try {
      data = await pushProfile({ baseUrl: this.baseUrl, token: this.#token, payload: { bot_id: botId, ...profile } });
    } catch (error) {
      const botListError = toBotListError(error);
      if (botListError.isAuthError) this.stop();
      throw botListError;
    }

    this.#sentProfileKey = profileKey(profile);
    this.#logger.debug(`Profil envoyé : ${profile.username}.`);
    if (data.review_required) {
      this.#logger.warn(
        `Le nom du bot a changé (${profile.username}) : sa fiche Bot List repasse en attente de vérification.`,
      );
    }
    this.#safeEmit('profilePosted', data);
    return data;
  }

  /** Cycle d'un envoi secondaire (commandes ou profil), indépendant du signal de vie. */
  async #syncTick(kind: SyncKind): Promise<void> {
    this.#sync[kind].timer = null;
    if (!this.#running) return;

    let delay: number | null;
    try {
      delay = kind === 'commands' ? await this.#syncCommands() : await this.#syncProfile();
      this.#sync[kind].failures = 0;
    } catch (error) {
      delay = this.#handleSyncError(kind, toBotListError(error));
    }

    if (this.#running && delay !== null) this.#scheduleSync(kind, delay * 1000);
  }

  /** Envoie les commandes seulement si elles ont changé. Renvoie le délai avant la prochaine vérification. */
  async #syncCommands(): Promise<number> {
    const botId = this.#primaryBotId();
    if (botId === null) return COMMANDS_INTERVAL;

    const commands = prepareCommands(await fetchGlobalCommands(this.client));
    const hash = hashCommands(commands);

    if (hash === this.#sentCommandsHash) {
      this.#logger.debug('Commandes inchangées, rien à envoyer.');
    } else if (hash === this.#rejectedCommandsHash) {
      this.#logger.debug("Commandes toujours trop volumineuses, rien à envoyer tant qu'elles ne changent pas.");
    } else {
      await this.#sendCommands(botId, commands, hash);
    }
    return COMMANDS_INTERVAL;
  }

  /** Envoie le profil seulement s'il a changé. Renvoie le délai avant la prochaine vérification. */
  async #syncProfile(): Promise<number> {
    const botId = this.#primaryBotId();
    if (botId === null) return PROFILE_INTERVAL;

    const profile = await fetchBotProfile(this.client);
    if (profileKey(profile) === this.#sentProfileKey) {
      this.#logger.debug('Profil inchangé, rien à envoyer.');
    } else {
      await this.#sendProfile(botId, profile);
    }
    return PROFILE_INTERVAL;
  }

  /** Renvoie le délai avant le prochain essai d'un envoi secondaire, en secondes, ou `null` pour arrêter. */
  #handleSyncError(kind: SyncKind, error: BotListError): number | null {
    if (error.isAuthError) {
      // Clé refusée : tous les envois s'arrêtent, signal de vie compris.
      this.stop();
      this.#emitError(error);
      return null;
    }

    if (error.code === 'rate_limited') {
      const retryAfter = Math.max(1, error.retryAfter ?? MIN_INTERVAL);
      this.#logger.debug(`Limite de requêtes atteinte, nouvel essai (${SYNC_LABELS[kind]}) dans ${retryAfter} s.`);
      this.#safeEmit('ratelimited', retryAfter);
      return retryAfter;
    }

    const state = this.#sync[kind];
    if (error.code === 'client_not_ready') {
      this.#logger.debug(error.message);
      state.failures += 1;
      return backoffDelay(state.failures, SYNC_INTERVALS[kind]);
    }

    this.#emitError(error);
    if (error.isTemporary || error.code === 'commands_fetch_failed' || error.code === 'profile_fetch_failed') {
      state.failures += 1;
      return backoffDelay(state.failures, SYNC_INTERVALS[kind]);
    }
    // 413, 422... : nouvelle vérification au cycle suivant.
    return SYNC_INTERVALS[kind];
  }

  #scheduleSync(kind: SyncKind, delayMs: number): void {
    const state = this.#sync[kind];
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      this.#syncTick(kind).catch((error: unknown) => this.#logger.error(`Erreur inattendue : ${String(error)}`));
    }, delayMs);
    // Ne pas empêcher le process de s'arrêter.
    state.timer.unref?.();
  }

  /** Renvoie le profil peu après une modification du compte du bot, sans attendre la vérification horaire. */
  #watchUserUpdates(): void {
    if (this.#userUpdateListener) return;
    this.#userUpdateListener = (_oldUser, newUser) => {
      const id = (newUser as { id?: unknown } | null)?.id;
      if (!this.#running || !this.#syncStarted || id === undefined || id !== this.client.user?.id) return;
      this.#logger.debug('Profil Discord du bot modifié, envoi à Bot List sous peu.');
      this.#scheduleSync('profile', PROFILE_UPDATE_DELAY_MS);
    };
    (this.client as unknown as EventEmitter).on('userUpdate', this.#userUpdateListener);
  }

  #normalInterval(): number {
    return this.#fixedInterval ?? clamp(this.#apiInterval, MIN_INTERVAL, MAX_INTERVAL);
  }

  #schedule(delayMs: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#tick().catch((error: unknown) => this.#logger.error(`Erreur inattendue : ${String(error)}`));
    }, delayMs);
    // Ne pas empêcher le process de s'arrêter.
    this.#timer.unref?.();
  }

  #waitForReady(): void {
    const onReady = (): void => {
      this.#clearReadyWatch();
      if (this.#running && !this.#timer) this.#schedule(0);
    };
    this.#readyListener = onReady;
    // 'clientReady' depuis discord.js 14.22 ; la vérification périodique couvre les versions antérieures
    // sans écouter 'ready', qui déclencherait un avertissement de dépréciation.
    (this.client as unknown as EventEmitter).once('clientReady', onReady);
    this.#readyPoll = setInterval(() => {
      if (this.#isClientReady()) onReady();
    }, READY_POLL_MS);
    this.#readyPoll.unref?.();
  }

  #clearReadyWatch(): void {
    if (this.#readyListener) {
      (this.client as unknown as EventEmitter).off('clientReady', this.#readyListener);
      this.#readyListener = null;
    }
    if (this.#readyPoll) clearInterval(this.#readyPoll);
    this.#readyPoll = null;
  }

  #isClientReady(): boolean {
    const client = this.client as Partial<Client>;
    return typeof client.isReady === 'function' ? client.isReady() : Boolean(client.readyAt);
  }

  #resolveInterval(interval: unknown): number | null {
    if (interval === undefined || interval === null) return null;
    if (typeof interval !== 'number' || !Number.isFinite(interval)) {
      this.#logger.warn('Option "interval" invalide (nombre de secondes attendu) : intervalle automatique utilisé.');
      return null;
    }
    const bounded = clamp(Math.round(interval), MIN_INTERVAL, MAX_INTERVAL);
    if (bounded !== interval) {
      const reason =
        interval > MAX_INTERVAL
          ? 'au-delà, le bot apparaîtrait « Hors ligne » (15 min sans signal)'
          : 'minimum imposé par Bot List';
      this.#logger.warn(`Option "interval" ramenée de ${interval} s à ${bounded} s (${reason}).`);
    }
    return bounded;
  }

  #emitError(error: BotListError): void {
    if (this.listenerCount('error') === 0) {
      // Sans écouteur, EventEmitter lèverait l'erreur et ferait planter le bot.
      this.#logger.error(error.message);
      return;
    }
    this.#safeEmit('error', error);
  }

  #safeEmit<E extends keyof BotListEvents>(event: E, ...args: BotListEvents[E]): void {
    try {
      this.emit(event, ...args);
    } catch (error) {
      this.#logger.error(`Un écouteur de l'événement "${event}" a levé une exception : ${String(error)}`);
    }
  }
}

/** 30 s, 60 s, 120 s... plafonné à `max`, en secondes. */
function backoffDelay(failures: number, max: number): number {
  return Math.min(BACKOFF_BASE * 2 ** (failures - 1), max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toBotListError(error: unknown): BotListError {
  if (error instanceof BotListError) return error;
  return new BotListError({ code: 'network_error', message: describeError('network_error'), cause: error });
}
