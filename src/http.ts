import { BotListError, describeError, type BotListErrorCode } from './errors.js';
import type { PushData, PushPayload } from './types.js';
import { SDK_VERSION } from './version.js';

export const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER = 60;

const API_ERROR_CODES = new Set<BotListErrorCode>([
  'missing_token',
  'invalid_token',
  'bot_mismatch',
  'owner_banned',
  'forbidden',
  'validation_failed',
  'rate_limited',
]);

interface ApiErrorBody {
  ok?: false;
  error?: string;
  message?: string;
  errors?: Record<string, unknown>;
  retry_after?: number;
}

export interface PushRequest {
  baseUrl: string;
  token: string;
  payload: PushPayload;
}

/** Envoie les statistiques à Bot List. Rejette toujours avec une `BotListError`. */
export async function pushStats({ baseUrl, token, payload }: PushRequest): Promise<PushData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/sdk/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `BotListSDK/${SDK_VERSION} (+https://botlist.top)`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (cause) {
    const code = controller.signal.aborted ? 'timeout' : 'network_error';
    throw new BotListError({ code, message: describeError(code), cause });
  } finally {
    clearTimeout(timeout);
  }

  const body = await readJson(response);
  const context = { botId: payload.bot_id, status: response.status };

  if (response.ok) {
    if (isRecord(body) && body.ok === true && isRecord(body.data)) {
      return body.data as unknown as PushData;
    }
    throw new BotListError({ code: 'invalid_response', status: response.status, message: describeError('invalid_response') });
  }

  if (response.status >= 500) {
    throw new BotListError({ code: 'server_error', status: response.status, message: describeError('server_error', context) });
  }

  const apiError = (isRecord(body) ? body : {}) as ApiErrorBody;
  const code = resolveCode(response.status, apiError.error);

  if (code === 'rate_limited') {
    const retryAfter = parseRetryAfter(apiError.retry_after, response.headers.get('retry-after'));
    throw new BotListError({ code, status: response.status, retryAfter, message: describeError(code) });
  }

  let message = describeError(code, context);
  if ((code === 'validation_failed' || code === 'http_error') && apiError.message) {
    message += ` Détail : ${apiError.message}`;
  }
  throw new BotListError({ code, status: response.status, message, errors: apiError.errors });
}

function resolveCode(status: number, apiCode: string | undefined): BotListErrorCode {
  if (apiCode && API_ERROR_CODES.has(apiCode as BotListErrorCode)) return apiCode as BotListErrorCode;
  switch (status) {
    case 401:
      return 'invalid_token';
    case 403:
      return 'forbidden';
    case 422:
      return 'validation_failed';
    case 429:
      return 'rate_limited';
    default:
      return 'http_error';
  }
}

function parseRetryAfter(fromBody: unknown, fromHeader: string | null): number {
  const candidates = [fromBody, fromHeader === null ? undefined : Number(fromHeader)];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.ceil(value);
  }
  return DEFAULT_RETRY_AFTER;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
