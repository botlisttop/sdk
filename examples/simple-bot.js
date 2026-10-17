// Bot simple, sans sharding.
// Lancement : node --env-file=.env simple-bot.js   (Node.js 20.6 ou plus récent)
const { Client, GatewayIntentBits } = require('discord.js');
const { BotListClient } = require('@botlisttop/sdk');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Envoie le nombre de serveurs dès la connexion, puis toutes les 5 minutes.
const botlist = new BotListClient(client, { token: process.env.BOTLIST_TOKEN });

botlist.on('posted', (data) => {
  console.log(`Bot List : ${data.server_count} serveurs envoyés.`);
});

botlist.on('error', (error) => {
  console.error(`Bot List : ${error.message}`);
});

client.login(process.env.DISCORD_TOKEN);
