# @botlisttop/sdk

SDK officiel de [Bot List](https://beta.botlist.top), l'annuaire de bots Discord.

Ajouté à votre bot discord.js, il envoie automatiquement à Bot List :

- le **nombre réel de serveurs** du bot (toutes shards additionnées), affiché sur sa fiche ;
- un **signal de vie** (heartbeat), qui permet au site d'afficher le bot **« En ligne »** ou **« Hors ligne »**.

Une ligne suffit : le SDK s'occupe de la planification, du sharding, des limites de requêtes et des erreurs réseau, sans jamais faire planter votre bot.

## Sommaire

- [Prérequis](#prérequis)
- [Installation](#installation)
- [Obtenir sa clé API](#obtenir-sa-clé-api)
- [Démarrage rapide](#démarrage-rapide)
- [Options](#options)
- [Méthodes et événements](#méthodes-et-événements)
- [Sharding](#sharding)
- [Statut en ligne / hors ligne](#statut-en-ligne--hors-ligne)
- [Gestion des erreurs](#gestion-des-erreurs)
- [Limites](#limites)
- [FAQ](#faq)
- [Licence](#licence)

## Prérequis

- **Node.js 18** ou plus récent.
- **discord.js v14**.
- Un bot enregistré sur Bot List, et sa clé API (voir [Obtenir sa clé API](#obtenir-sa-clé-api)).

Le SDK n'a aucune autre dépendance : il utilise le `fetch` natif de Node.js.

## Installation

```bash
npm install @botlisttop/sdk
```

```bash
yarn add @botlisttop/sdk
```

```bash
pnpm add @botlisttop/sdk
```

## Obtenir sa clé API

1. Connectez-vous sur [Bot List](https://beta.botlist.top) et ouvrez votre **Dashboard**.
2. Ouvrez la **fiche de votre bot**.
3. Rendez-vous dans la section **API développeur**.
4. Cliquez sur **Générer la clé** (ou **Afficher la clé** si elle existe déjà). Elle commence par `blt_`.
5. Copiez-la dans un fichier `.env` à la racine de votre projet :

```env
DISCORD_TOKEN=votre_token_discord
BOTLIST_TOKEN=blt_votre_cle_bot_list
```

Cette clé est propre à **un seul bot** : elle ne fonctionne qu'avec le bot dont elle provient.

> **Important** : la clé est secrète. Ne la commitez jamais. Ajoutez `.env` à votre `.gitignore`. Si elle a fuité, régénérez-la depuis le dashboard : l'ancienne cesse aussitôt de fonctionner.

Pour charger le fichier `.env`, lancez votre bot avec `node --env-file=.env index.js` (Node.js 20.6 ou plus récent), ou utilisez le paquet [dotenv](https://www.npmjs.com/package/dotenv) sous Node.js 18.

## Démarrage rapide

**JavaScript (CommonJS)**

```js
const { Client, GatewayIntentBits } = require('discord.js');
const { BotListClient } = require('@botlisttop/sdk');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
new BotListClient(client, { token: process.env.BOTLIST_TOKEN });
client.login(process.env.DISCORD_TOKEN);
```

**TypeScript / ESM**

```ts
import { Client, GatewayIntentBits } from 'discord.js';
import { BotListClient } from '@botlisttop/sdk';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
new BotListClient(client, { token: process.env.BOTLIST_TOKEN! });
client.login(process.env.DISCORD_TOKEN);
```

C'est tout. Dès que le bot est connecté, le SDK envoie ses statistiques, puis recommence toutes les 5 minutes.

L'intent `Guilds` est nécessaire pour que discord.js connaisse la liste des serveurs.

## Options

`new BotListClient(client, options)`

| Option     | Type      | Défaut                     | Description |
| ---------- | --------- | -------------------------- | ----------- |
| `token`    | `string`  | requis                     | Clé API du bot (`blt_...`). |
| `autoPost` | `boolean` | `true`                     | Envoie automatiquement les statistiques. Avec `false`, rien n'est envoyé tant que vous n'appelez pas `start()` ou `postStats()`. |
| `interval` | `number`  | automatique (300 s)        | Délai entre deux envois, **en secondes**. Par défaut, le SDK suit la valeur conseillée par l'API. Une valeur fixe est ramenée entre **60 s** et **840 s**, avec un avertissement dans la console. Au-delà de 840 s, le bot risquerait de passer « Hors ligne ». |
| `baseUrl`  | `string`  | `https://beta.botlist.top` | URL de l'API Bot List. |
| `debug`    | `boolean` | `false`                    | Affiche des logs de diagnostic préfixés par `[BotList]`. La clé n'apparaît jamais en clair : elle est masquée (`blt_****`). |

## Méthodes et événements

### Méthodes

| Méthode       | Retour                      | Description |
| ------------- | --------------------------- | ----------- |
| `postStats()` | `Promise<PushData \| null>` | Envoie les statistiques immédiatement et renvoie la réponse de l'API. Renvoie `null` sur une shard autre que 0. En cas d'échec, la promesse est rejetée avec une `BotListError` : pensez au `try/catch`. |
| `start()`     | `void`                      | Démarre l'envoi automatique. Appelée par le constructeur sauf si `autoPost` vaut `false`. Sans effet si l'envoi tourne déjà. |
| `stop()`      | `void`                      | Arrête l'envoi automatique. Le bot passera « Hors ligne » 15 minutes après le dernier envoi. |

La propriété `running` (`boolean`) indique si l'envoi automatique est actif.

L'objet `PushData` renvoyé par l'API :

| Champ           | Type             | Description |
| --------------- | ---------------- | ----------- |
| `bot_id`        | `string`         | ID Discord du bot. |
| `server_count`  | `number`         | Nombre de serveurs enregistré. |
| `shard_count`   | `number \| null` | Nombre de shards enregistré. |
| `online`        | `boolean`        | Statut du bot après l'envoi. |
| `received_at`   | `string`         | Date de réception (ISO 8601). |
| `next_push_in`  | `number`         | Délai conseillé avant le prochain envoi, en secondes. |
| `online_window` | `number`         | Durée pendant laquelle le bot reste « En ligne » sans nouvel envoi, en secondes. |

### Événements

| Événement     | Argument                 | Quand |
| ------------- | ------------------------ | ----- |
| `posted`      | `data: PushData`         | Après chaque envoi réussi (automatique ou manuel). |
| `error`       | `error: BotListError`    | Lors d'un échec de l'envoi automatique. Voir [Gestion des erreurs](#gestion-des-erreurs). |
| `ratelimited` | `retryAfter: number`     | Quand l'API impose une pause (HTTP 429). `retryAfter` est en secondes. Le SDK reprend seul ensuite. |

Si aucun écouteur `error` n'est attaché, le SDK affiche l'erreur dans la console au lieu de la lever : votre bot ne plante jamais à cause de Bot List.

**JavaScript**

```js
const botlist = new BotListClient(client, { token: process.env.BOTLIST_TOKEN });

botlist.on('posted', (data) => {
  console.log(`Bot List : ${data.server_count} serveurs envoyés.`);
});

botlist.on('ratelimited', (retryAfter) => {
  console.warn(`Bot List : pause de ${retryAfter} s.`);
});

botlist.on('error', (error) => {
  console.error(`Bot List [${error.code}] : ${error.message}`);
});
```

**TypeScript**

```ts
import { BotListClient, BotListError, type PushData } from '@botlisttop/sdk';

const botlist = new BotListClient(client, { token: process.env.BOTLIST_TOKEN! });

botlist.on('posted', (data: PushData) => {
  console.log(`Bot List : ${data.server_count} serveurs envoyés.`);
});

botlist.on('error', (error: BotListError) => {
  console.error(`Bot List [${error.code}] : ${error.message}`);
});
```

### Envoi manuel

Pour gérer vous-même le moment des envois, désactivez `autoPost` et appelez `postStats()` :

**JavaScript**

```js
const botlist = new BotListClient(client, {
  token: process.env.BOTLIST_TOKEN,
  autoPost: false,
});

client.once('clientReady', async () => {
  try {
    const data = await botlist.postStats();
    console.log(`Envoyé : ${data.server_count} serveurs.`);
  } catch (error) {
    console.error(error.message);
  }
});
```

**TypeScript**

```ts
const botlist = new BotListClient(client, {
  token: process.env.BOTLIST_TOKEN!,
  autoPost: false,
});

client.once('clientReady', async () => {
  try {
    const data = await botlist.postStats();
    console.log(`Envoyé : ${data?.server_count} serveurs.`);
  } catch (error) {
    if (error instanceof BotListError) console.error(error.message);
  }
});
```

Avant discord.js 14.22, l'événement s'appelle `ready` au lieu de `clientReady`. Le SDK, lui, gère les deux versions automatiquement.

Sans envoi régulier (au moins toutes les 15 minutes), le bot apparaîtra « Hors ligne ». Dans la plupart des cas, laissez `autoPost` activé.

## Sharding

Avec un `ShardingManager`, initialisez le SDK **dans le fichier du bot** (celui que lance le manager), pas dans le fichier du manager. Le SDK gère le reste :

- toutes les shards l'initialisent, mais **seule la shard 0** envoie les statistiques ;
- la shard 0 additionne les serveurs de **toutes** les shards (via `client.shard.fetchClientValues`) et envoie le nombre de shards ;
- si certaines shards ne sont pas encore prêtes au démarrage, le SDK réessaie automatiquement quelques secondes plus tard.

**`index.js`** (manager) :

```js
const path = require('node:path');
const { ShardingManager } = require('discord.js');

const manager = new ShardingManager(path.join(__dirname, 'bot.js'), {
  token: process.env.DISCORD_TOKEN,
});

manager.spawn();
```

**`bot.js`** (exécuté par chaque shard), en JavaScript :

```js
const { Client, GatewayIntentBits } = require('discord.js');
const { BotListClient } = require('@botlisttop/sdk');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
new BotListClient(client, { token: process.env.BOTLIST_TOKEN });
client.login();
```

**`bot.ts`**, en TypeScript :

```ts
import { Client, GatewayIntentBits } from 'discord.js';
import { BotListClient } from '@botlisttop/sdk';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
new BotListClient(client, { token: process.env.BOTLIST_TOKEN! });
client.login();
```

Sans `ShardingManager`, rien à configurer : le SDK utilise `client.guilds.cache.size`.

## Statut en ligne / hors ligne

Bot List ne se connecte pas à Discord pour savoir si votre bot tourne : il se fie aux envois du SDK.

- Chaque envoi est un **signal de vie**. Le SDK en envoie un **toutes les 5 minutes**.
- Le bot est affiché **« En ligne »** tant que son dernier envoi date de **moins de 15 minutes**.
- Après **15 minutes sans signal** (bot arrêté, planté, déconnecté, clé invalide...), il passe **« Hors ligne »**.

Une coupure réseau brève ne suffit donc pas à faire passer le bot hors ligne : le SDK réessaie bien avant la fin des 15 minutes.

## Gestion des erreurs

Toutes les erreurs sont des instances de `BotListError`, avec :

| Propriété     | Type                   | Description |
| ------------- | ---------------------- | ----------- |
| `code`        | `string`               | Code de l'erreur (voir le tableau ci-dessous). |
| `status`      | `number \| undefined`  | Code HTTP, absent pour les erreurs réseau. |
| `message`     | `string`               | Explication en français, avec la marche à suivre. |
| `retryAfter`  | `number \| undefined`  | Pause imposée en secondes (429). |
| `errors`      | `object \| undefined`  | Détail des champs refusés (422). |
| `isAuthError` | `boolean`              | `true` pour une clé absente ou refusée (401 / 403). |
| `isTemporary` | `boolean`              | `true` pour une erreur temporaire (5xx, réseau, délai dépassé). |

| HTTP          | `code`                                     | Signification | Réaction du SDK | Que faire |
| ------------- | ------------------------------------------ | ------------- | --------------- | --------- |
| -             | `missing_token`                            | Aucune clé fournie. | Aucun envoi. | Vérifiez que `BOTLIST_TOKEN` est défini et que le `.env` est bien chargé. |
| 401           | `missing_token`, `invalid_token`           | Clé absente ou invalide. | **Arrêt** de l'envoi automatique. | Régénérez la clé dans le dashboard (fiche du bot > API développeur) et mettez à jour le `.env`. |
| 403           | `bot_mismatch`                             | La clé appartient à un autre bot. | **Arrêt**. | Utilisez la clé du bot connecté, ou vérifiez que vous lancez le bon bot. |
| 403           | `owner_banned`                             | Le propriétaire du bot est banni. | **Arrêt**. | Contactez l'équipe Bot List. |
| 403           | `forbidden`                                | Envoi refusé pour ce bot. | **Arrêt**. | Vérifiez que le bot est bien enregistré sur Bot List. |
| 422           | `validation_failed`                        | Données refusées. | Nouvel essai au cycle suivant. | Consultez `error.errors`. Si l'erreur persiste, mettez le SDK à jour. |
| 429           | `rate_limited`                             | Trop de requêtes. | Événement `ratelimited`, pause de `retryAfter` secondes, puis reprise. | Réduisez vos appels manuels à `postStats()`. |
| 5xx           | `server_error`                             | Bot List indisponible. | Nouvel essai après 30 s, 60 s, 120 s... (au plus 5 min). | Rien : le SDK reprend seul. |
| -             | `network_error`, `timeout`                 | Réseau coupé, ou pas de réponse en 10 s. | Idem. | Vérifiez la connexion de l'hébergeur si cela dure. |
| 200           | `invalid_response`                         | Réponse illisible. | Idem. | Rien. |
| -             | `client_not_ready`                         | `postStats()` appelé avant la connexion à Discord. | - | Attendez l'événement `clientReady`. |
| -             | `shards_not_ready`                         | Shards pas toutes prêtes. | Nouvel essai sous peu. | Rien. |

Après un arrêt dû à la clé (401 / 403), corrigez la clé puis redémarrez le bot. Vous pouvez aussi recréer un `BotListClient` avec la nouvelle clé.

**JavaScript**

```js
botlist.on('error', (error) => {
  if (error.isAuthError) {
    console.error(`Bot List arrêté : ${error.message}`);
  } else {
    console.warn(`Bot List [${error.code}] : ${error.message}`);
  }
});
```

**TypeScript**

```ts
import type { BotListError } from '@botlisttop/sdk';

botlist.on('error', (error: BotListError) => {
  if (error.isAuthError) {
    console.error(`Bot List arrêté : ${error.message}`);
  } else {
    console.warn(`Bot List [${error.code}] : ${error.message}`);
  }
});
```

## Limites

- **10 requêtes par minute et par bot.** L'envoi automatique en utilise une toutes les 5 minutes : la limite ne concerne que les appels manuels à `postStats()`. En cas de dépassement, le SDK attend le délai indiqué par l'API.
- Intervalle minimum : **60 s**. Intervalle maximum : **840 s** (14 min), pour rester sous la fenêtre de 15 minutes du statut en ligne.
- Délai maximum d'une requête : **10 s**.

## FAQ

**Le nombre de serveurs n'apparaît pas sur ma fiche.**
- Vérifiez que le bot est bien connecté : le premier envoi a lieu à la connexion à Discord.
- Activez `debug: true` et écoutez l'événement `error` : un message explique la cause.
- Vérifiez que le client a l'intent `GatewayIntentBits.Guilds`, sinon discord.js ne connaît pas les serveurs.
- Avec un `ShardingManager`, le SDK doit être initialisé dans le fichier du bot, pas dans celui du manager.

**Mon bot reste « Hors ligne ».**
- Le SDK doit envoyer au moins un signal toutes les 15 minutes. Vérifiez qu'aucune erreur `invalid_token` ou `bot_mismatch` n'est émise : dans ce cas, l'envoi est arrêté.
- Vérifiez que vous n'avez pas appelé `stop()` ou passé `autoPost: false` sans appeler `postStats()` régulièrement.
- Après le démarrage du bot, le statut se met à jour dès le premier envoi réussi.

**J'ai l'erreur `bot_mismatch`.**
La clé a été générée pour un autre bot. Chaque bot a sa propre clé : utilisez celle de la fiche du bot que vous lancez.

**J'ai régénéré ma clé et tout s'est arrêté.**
C'est normal : l'ancienne clé ne fonctionne plus. Mettez à jour `BOTLIST_TOKEN` dans le `.env` et redémarrez le bot.

**Le SDK peut-il faire planter mon bot ?**
Non. Toutes les erreurs sont interceptées : elles sont émises via l'événement `error`, ou affichées dans la console si aucun écouteur n'est attaché. Les minuteurs n'empêchent pas non plus le process de s'arrêter.

**Ma clé apparaît-elle dans les logs ?**
Non, jamais, même avec `debug: true` : elle est masquée (`blt_****`).

**Puis-je envoyer les statistiques plus souvent ?**
Inutile : un envoi toutes les 5 minutes suffit pour le statut en ligne, et la limite est de 10 requêtes par minute. Vous pouvez appeler `postStats()` ponctuellement, par exemple quand le bot rejoint un serveur.

**Le SDK fonctionne-t-il avec TypeScript ?**
Oui. Les types sont inclus : options, réponses, erreurs et événements sont typés.

## Exemples

Le dossier [`examples/`](./examples) contient :

- [`simple-bot.js`](./examples/simple-bot.js) : bot simple ;
- [`sharding/`](./examples/sharding) : bot avec `ShardingManager` ;
- [`events.ts`](./examples/events.ts) : usage des événements et de l'envoi manuel en TypeScript.

## Licence

[MIT](./LICENSE) - Bot List Top
