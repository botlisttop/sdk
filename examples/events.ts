// Usage complet des événements, de l'envoi manuel et des commandes slash, en TypeScript.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { BotListClient, BotListError, type CommandsData, type PushData } from '@botlisttop/sdk';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const botlist = new BotListClient(client, {
  token: process.env.BOTLIST_TOKEN ?? '',
  debug: process.env.NODE_ENV !== 'production',
});

botlist.on('posted', (data: PushData) => {
  console.log(`Bot List : ${data.server_count} serveurs, prochain envoi dans ${data.next_push_in} s.`);
});

botlist.on('commandsPosted', (data: CommandsData) => {
  const state = data.changed ? 'mises à jour' : 'inchangées';
  console.log(`Bot List : ${data.commands_count} commandes ${state}.`);
});

botlist.on('ratelimited', (retryAfter: number) => {
  console.warn(`Bot List : limite atteinte, reprise dans ${retryAfter} s.`);
});

botlist.on('error', (error: BotListError) => {
  if (error.isAuthError) {
    // 401 / 403 : tous les envois automatiques sont arrêtés, la clé doit être corrigée.
    console.error(`Bot List (envoi arrêté) : ${error.message}`);
    return;
  }
  // Erreurs temporaires ou de validation : le SDK réessaie tout seul.
  console.warn(`Bot List [${error.code}] : ${error.message}`);
});

// Envoi immédiat après un ajout de serveur, sans attendre le prochain cycle.
// Attention à la limite de 10 requêtes par minute.
client.on(Events.GuildCreate, async () => {
  try {
    await botlist.postStats();
  } catch (error) {
    if (error instanceof BotListError) console.warn(`Bot List : ${error.message}`);
  }
});

// Envoi immédiat des commandes après un déploiement, sans attendre la vérification horaire.
client.once(Events.ClientReady, async (readyClient) => {
  await readyClient.application.commands.set([
    { name: 'ping', description: 'Répond pong', nameLocalizations: { 'en-US': 'ping' } },
  ]);
  try {
    await botlist.postCommands();
  } catch (error) {
    if (error instanceof BotListError) console.warn(`Bot List : ${error.message}`);
  }
});

// Arrêt propre.
process.on('SIGINT', () => {
  botlist.stop();
  void client.destroy();
});

void client.login(process.env.DISCORD_TOKEN);
