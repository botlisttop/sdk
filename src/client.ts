import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { BotListError, describeError } from './errors.js';
import { pushStats } from './http.js';
import { Logger, maskToken } from './logger.js';
import { collectStats, isPrimaryShard } from './stats.js';
import type { BotListClientOptions, BotListEvents, PushData } from './types.js';
import { SDK_VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://beta.botlist.top';
/** Intervalle par défaut tant que l'API n'a pas donné `next_push_in`, en secondes. */
export const DEFAULT_INTERVAL = 300;
export const MIN_INTERVAL = 60;
/** Au-delà de 15 min sans envoi, le bot passe « Hors ligne » : on garde une marge. */
export const MAX_INTERVAL = 840;
/** Premier délai de nouvel essai après une erreur temporaire, en secondes. */
export const BACKOFF_BASE = 30;
const READY_POLL_MS = 2_000;

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
 * Envoie automatiquement à Bot List le nombre de serveurs du bot et un signal de vie.
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

  #running = false;
  #timer: NodeJS.Timeout | null = null;
  #readyPoll: NodeJS.Timeout | null = null;
  #readyListener: (() => void) | null = null;
  #apiInterval = DEFAULT_INTERVAL;
  #failures = 0;

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
    if (!this.#token) {
      this.stop();
      throw new BotListError({ code: 'missing_token', message: describeError('missing_token') });
    }
    if (!isPrimaryShard(this.client)) return null;

    const botId = this.client.user?.id;
    if (!botId) {
      throw new BotListError({ code: 'client_not_ready', message: describeError('client_not_ready') });
    }

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
    this.#clearReadyWatch();
  }

  async #tick(): Promise<void> {
    this.#timer = null;
    if (!this.#running) return;

    let delay: number | null;
    try {
      await this.postStats();
      this.#failures = 0;
      delay = this.#normalInterval();
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
    return Math.min(BACKOFF_BASE * 2 ** (this.#failures - 1), this.#normalInterval());
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toBotListError(error: unknown): BotListError {
  if (error instanceof BotListError) return error;
  return new BotListError({ code: 'network_error', message: describeError('network_error'), cause: error });
}
