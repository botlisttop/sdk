const PREFIX = '[BotList]';

/** Masque une clé API pour l'affichage. La clé n'est jamais loggée en clair. */
export function maskToken(token: string | undefined): string {
  if (!token) return '(aucune)';
  return token.startsWith('blt_') ? 'blt_****' : '****';
}

export class Logger {
  constructor(private readonly enabled: boolean) {}

  debug(message: string): void {
    if (this.enabled) console.log(`${PREFIX} ${message}`);
  }

  warn(message: string): void {
    console.warn(`${PREFIX} ${message}`);
  }

  error(message: string): void {
    console.error(`${PREFIX} ${message}`);
  }
}
