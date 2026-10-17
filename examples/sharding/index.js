// Point d'entrée avec ShardingManager : lance bot.js une fois par shard.
// Lancement : node --env-file=.env index.js   (Node.js 20.6 ou plus récent)
const path = require('node:path');
const { ShardingManager } = require('discord.js');

const manager = new ShardingManager(path.join(__dirname, 'bot.js'), {
  token: process.env.DISCORD_TOKEN,
  totalShards: 'auto',
});

manager.on('shardCreate', (shard) => console.log(`Shard ${shard.id} lancée.`));
manager.spawn();
