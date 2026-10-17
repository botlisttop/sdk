// Code exécuté par chaque shard. Le SDK s'initialise dans toutes les shards,
// mais seule la shard 0 envoie, avec le total des serveurs de toutes les shards.
const { Client, GatewayIntentBits } = require('discord.js');
const { BotListClient } = require('@botlisttop/sdk');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const botlist = new BotListClient(client, { token: process.env.BOTLIST_TOKEN });

botlist.on('posted', (data) => {
  console.log(`Bot List : ${data.server_count} serveurs sur ${data.shard_count} shards.`);
});

botlist.on('error', (error) => {
  console.error(`Bot List : ${error.message}`);
});

// Le token Discord est transmis par le ShardingManager.
client.login();
