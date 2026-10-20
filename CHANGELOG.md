# Changelog

Toutes les évolutions notables de `@botlisttop/sdk` sont listées ici.
Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le projet respecte le [versionnage sémantique](https://semver.org/lang/fr/).

## [1.0.0] - 2026-10-21

### Modifié

- L'URL par défaut de l'API passe de `https://beta.botlist.top` à `https://botlist.top` (production). Pour viser un autre environnement, passez l'option `baseUrl`.

### Ajouté

- Mise à jour automatique du profil du bot sur sa fiche : nom, avatar et bannière (`POST /api/sdk/profile`).
  - Premier envoi juste après le premier signal de vie réussi, puis vérification toutes les heures. Le profil n'est renvoyé que s'il a changé.
  - Envoi 5 secondes après un événement `userUpdate` du bot, sans attendre la vérification horaire.
  - Un changement de nom fait repasser la fiche en attente de vérification : le SDK le signale dans la console.
  - Minuteur indépendant, comme pour les commandes : un échec ne retarde ni n'interrompt le signal de vie.
- Option `postProfile` (défaut : `true`), méthode `postProfile()` et événement `profilePosted`.
- Types `ProfileData` et `ProfilePayload`, constante `PROFILE_INTERVAL`.
- Code d'erreur `profile_fetch_failed` (échec de la récupération du profil auprès de Discord).

## [0.3.0] - 2026-10-20

### Ajouté

- Publication automatique sur npmjs à chaque Release GitHub, par trusted publishing (OIDC) avec attestation de provenance.
- Champ `repository` dans le `package.json`, qui relie le paquet au dépôt GitHub.

## [0.2.0] - 2026-10-20

### Ajouté

- Envoi des commandes slash globales du bot (`POST /api/sdk/commands`), affichées dans l'onglet « Commandes » de sa fiche sur Bot List.
  - Premier envoi juste après le premier signal de vie réussi, puis vérification toutes les heures. Les commandes ne sont renvoyées que si elles ont changé.
  - Seules les commandes globales sont envoyées, jamais les commandes de serveur.
  - Seuls les champs affichés par Bot List sont transmis, traductions comprises.
  - Minuteur indépendant : un échec sur les commandes ne retarde ni n'interrompt le signal de vie. Seule une clé refusée (401 / 403) arrête tous les envois.
- Option `postCommands` (défaut : `true`).
- Méthode `postCommands()` pour un envoi immédiat.
- Événement `commandsPosted`.
- Types `CommandsData` et `CommandsPayload`, constante `COMMANDS_INTERVAL`.
- Codes d'erreur `payload_too_large` (413 : pas de nouvel essai tant que la liste ne change pas) et `commands_fetch_failed` (échec de la récupération auprès de Discord).

## [0.1.0] - 2026-10-17

### Ajouté

- Première version : envoi automatique du nombre de serveurs et du signal de vie (`POST /api/sdk/push`) toutes les 5 minutes.
- Prise en charge du `ShardingManager` : seule la shard 0 envoie le total de toutes les shards.
- Gestion des erreurs : arrêt sur clé refusée (401 / 403), pause sur limite de requêtes (429), délai croissant sur les erreurs temporaires (5xx, réseau, délai dépassé).
- Événements `posted`, `error` et `ratelimited`, méthodes `postStats()`, `start()` et `stop()`.
- Builds CommonJS et ESM, types TypeScript inclus.

[1.0.0]: https://github.com/botlisttop/sdk/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/botlisttop/sdk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/botlisttop/sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/botlisttop/sdk/releases/tag/v0.1.0
