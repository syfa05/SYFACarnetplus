# Revue du lot L2 — Authentification

Document destiné au **relecteur** (humain indépendant, ou session Claude neuve sans l'historique du développement).
Le dossier prévoit « un lot = une branche, une demande de fusion, une revue humaine » (onglet 10, §10.1) et « relire les tests avant le code » (§10.5).

> **Pourquoi une relecture indépendante.** Le code a été écrit et relu par le même agent, sur quatre tours. Chaque tour a trouvé des défauts que le précédent avait manqués, y compris une affirmation fausse de l'auteur. Une personne qui n'a pas écrit le code a des angles morts différents.

---

## 1. Périmètre

| | |
|---|---|
| Branche | `claude/fervent-cerf-njewtz` |
| Base (fin du lot L1) | `9136487` |
| Lot L2 | `cbb080c` → `7e9015c` → `dab4318` → `d834ac3` (livraison + trois séries de corrections), puis `cf45531` (suppression de `src/auth.ts`, tests regroupés par thème) |
| État vérifié | clone propre : lint, build, **186/186 tests sur PostgreSQL 16**, 182 + 4 ignorés sur PGlite ; **CI GitHub verte** (jobs `gateway` et `image` : construction, signature cosign, vérification) |

```bash
git fetch origin claude/fervent-cerf-njewtz && git checkout claude/fervent-cerf-njewtz
git diff 9136487 cf45531 --stat
git diff 9136487 cf45531 -- services/gateway/src services/gateway/migrations/002_auth.sql \
  infra .env.example docs/DECISIONS.md i18n
```

### Exigences visées (onglet 1, §1.5 ; onglet 6, §6.2)
- **F-AUTH-01** : un patient se connecte avec son numéro et un code SMS valable 10 minutes, 3 essais maximum.
- **F-AUTH-02** : après 5 PIN erronés, un nouveau code SMS est exigé.
- **F-AUTH-03** : un professionnel ne peut pas se connecter sans second facteur.
- **F-AUTH-04** : une session professionnelle inactive se ferme après 15 min (poste partagé) / 30 min (smartphone).
- **F-JRN-02** : aucun SMS ne contient de nom d'établissement, de contenu médical ou de lien.
- **Menaces §6.2** : usurpation d'un compte professionnel, vol ou perte d'appareil, hameçonnage des patients, accès abusif.
- Prompt de lot L2 (onglet 10) : authentification patients / professionnels / systèmes, sessions, limitation de débit sur toutes les routes d'authentification.

### Hors périmètre de ce lot (ne pas signaler comme défauts du lot)
| Sujet | Où il sera traité |
|---|---|
| Autorisation selon la matrice des permissions (onglet 2) sur toutes les routes | Lot L3 |
| Second facteur de secours par SMS pour les professionnels (extension Keycloak) | À évaluer |
| TLS mutuel des systèmes (terminé par le reverse proxy) | Lot L18 |
| Blocage d'un appareil après 14 jours sans synchronisation (T-NET-05) | Lot L12 |
| Passerelle SMS complète, deux prestataires, bascule (T-PAN-03) | Lot L11 |
| Journal infalsifiable chaîné par hachage (la table `auth_event` en est la source) | Lot L11 |
| Purges périodiques (OTP, sessions, limitation de débit, appareils révoqués) | Lot L18 |
| Biométrie optionnelle, application patient | Lot L14 |

---

## 2. Préparer l'environnement

```bash
make lint test                                   # PGlite : aucune installation, 4 tests de concurrence ignorés
TEST_DATABASE_URL=postgres://utilisateur:motdepasse@localhost:5432/base_de_test \
  npm --prefix services/gateway test             # PostgreSQL réel : tous les tests (comme la CI)
```
Chaque test crée son propre schéma : rien n'est partagé. Carte des fichiers : `services/gateway/test/README.md`.

**Non testable sans infrastructure** (à faire par le relecteur ou l'équipe d'exploitation) :
- importer `infra/keycloak/syfa-realm.json` dans un Keycloak réel et configurer le flux « step-up » du second facteur (`infra/keycloak/README.md`) ;
- `make up` (démarrage complet) ;
- un fournisseur SMS réel (délai, coût, couverture MTN / Orange / Camtel).

---

## 3. Ordre de lecture recommandé

1. **`docs/DECISIONS.md`**, sections « Lot L2 » et « Revue L2 » : décisions, écarts avec le dossier, limites.
2. **Les tests** (`services/gateway/test/auth/`) — un test absent est une exigence non vérifiée :
   `otp` → `pin` → `patient-sessions` → `professional-auth` → `devices` → `network` → `rate-limit` → `unit`.
3. **Le code** (`services/gateway/src/auth/`) :
   - `hook.ts` — contrôle de **chaque** requête (le fichier le plus important) ;
   - `patient.ts` — codes SMS, PIN, sessions des patients ;
   - `devices.ts` — appareils des professionnels et alerte ;
   - `network-guard.ts`, `network.ts` — restriction réseau et confiance au proxy ;
   - `sessions.ts`, `rate-limit.ts`, `crypto.ts`, `tokens.ts`, `config.ts`, `routes.ts` ;
   - `../app.ts`, `../config.ts`.
4. **`migrations/002_auth.sql`** et **`infra/`** (Compose, realm Keycloak).

---

## 4. Routes exposées

| Route | Accès | Rôle |
|---|---|---|
| `POST /v1/auth/patient/otp/request` | public, limitée | demande de code SMS |
| `POST /v1/auth/patient/otp/verify` | public, limitée | code + choix du PIN → enrôlement de l'appareil et session |
| `POST /v1/auth/patient/unlock` | public, limitée | secret d'appareil + PIN → session |
| `POST /v1/auth/patient/refresh` | public, limitée | rotation du jeton de rafraîchissement |
| `POST /v1/auth/logout` | jeton | ferme la session |
| `POST /v1/auth/devices` | jeton professionnel, **réseau autorisé** | enrôle un appareil (alerte SMS obligatoire) |
| `GET /v1/auth/devices`, `DELETE /v1/auth/devices/:id` | jeton professionnel | liste, révoque ses propres appareils |
| `GET /v1/me` | jeton | identité du principal (sonde de contrôle) |
| `GET /health` | public | sonde, sans donnée |

Trois types de principal : **patient** (jeton émis par la passerelle, ES256), **professionnel** et **système** (jetons Keycloak).

### Valeurs par défaut (toutes paramétrables, `src/auth/config.ts`)
OTP 6 chiffres / 600 s / 3 essais · renvoi 60 s · 5 demandes et 30 vérifications par heure et par numéro · PIN 4 chiffres / 5 essais / PIN triviaux refusés · inactivité 900 s (poste partagé), 1800 s (smartphone et patient) · jeton d'accès 300 s · session patient 12 h · 30 requêtes par minute et par adresse sur `/v1/auth/*` · 5 appareils actifs et 5 enrôlements par heure et par professionnel · réseaux autorisés : boucle locale seulement · clients restreints : `syfa-web`.

---

## 5. Le prompt de revue (§10.4)

À donner au relecteur avec le diff et les onglets 1 à 8 (`docs/Doc_SYFACarnet+.zip`) :

> Tu es relecteur sécurité et qualité du projet SYFA Carnet+. Examine la demande de fusion jointe au regard des onglets 1 à 8.
> Vérifie et rends un rapport en quatre parties :
> 1. **CONFORMITÉ** : chaque exigence annoncée est-elle réellement couverte par du code et un test ? Liste celles qui manquent.
> 2. **AUTORISATION** : existe-t-il un chemin (interface, API, synchronisation, export, notification, journal) qui contourne la matrice de l'onglet 2 ?
> 3. **DONNÉES** : une donnée médicale peut-elle être écrasée, perdue pendant une synchronisation, envoyée dans un SMS, ou sortir de l'environnement ?
> 4. **QUALITÉ** : textes en dur, valeurs paramétrables codées en dur, dépendances à risque, tests désactivés, gestion d'erreurs absente.
>
> Pour chaque problème : fichier, ligne, gravité (bloquant, majeur, mineur), correction proposée. Ne valide pas la demande s'il reste un problème bloquant ou majeur.

**Consigne complémentaire (importante)** :
> Essaie de contourner chaque contrôle avec un script ou un test, et ne rapporte que ce que tu as reproduit ou que tu peux justifier précisément par le code. Distingue explicitement ce que tu as reproduit de ce que tu déduis. Ne signale pas les points listés en §1 « Hors périmètre ».

---

## 6. Où concentrer l'attention

Les défauts trouvés jusqu'ici se répartissent en quatre familles : cherche des **variantes** dans chacune.

### A. Contournements de contrôle
- Restriction réseau des postes partagés (`network-guard.ts`) : peut-on faire évaluer une autre adresse que celle du client ? (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, IPv6, adresse IPv4 intégrée dans IPv6, pair interne, liste `TRUST_PROXY` erronée ou trop large.)
- Un attaquant disposant du mot de passe **et** du code TOTP : quelle est la meilleure voie qui reste ouverte ? (client Android, appareil déjà enrôlé, client « système ».) La restriction réseau ne l'arrête pas dans ces cas — est-ce acceptable ?
- Second facteur : jeton sans `amr`/`acr`, `acr` non numérique, client inconnu, algorithme inattendu, jeton d'un type utilisé pour l'autre.
- Appareils : enrôlement hors réseau, clé d'appareil réutilisée entre utilisateurs, appareil révoqué réenregistré.

### B. Concurrence et compteurs
- Essais de code SMS (3) et de PIN (5) : compteurs atomiques, comptés **avant** la comparaison — est-ce vrai sur tous les chemins ?
- Usage unique du code, plafond d'appareils (verrou consultatif par professionnel), rotation des jetons de rafraîchissement (réutilisation = révocation).
- Quotas partagés entre instances (PostgreSQL) : fenêtres fixes, rejeu aux frontières.
- Transactions qui tiennent une connexion et en réclament une autre (blocage du pool) : un défaut de ce type a déjà été trouvé.

### C. Fuites d'information
- Numéro connu / inconnu / ambigu : réponses, codes d'état, écritures SQL, **temps de réponse** (non garanti à la milliseconde).
- Codes d'erreur : rien de la configuration ni d'un système externe ne doit sortir ; messages d'erreur externes (FHIR, SMS, base) jamais conservés ni journalisés.
- Journaux (`auth_event`), table de limitation (aucune adresse ni numéro en clair), secrets (codes, PIN, jetons, clés d'appareil) jamais stockés en clair ni journalisés.

### D. Défaillance silencieuse
- Que se passe-t-il quand une configuration est fausse, qu'un service tombe (SMS, base), qu'un proxy est mal déclaré ? Le comportement attendu est un **refus bruyant**, jamais une ouverture silencieuse.
- Attention aux affirmations de la documentation : une phrase « jamais X » doit être vérifiée contre le code (l'une d'elles s'est révélée fausse).

### Autres pistes
- Entrées : validation stricte (champs inconnus refusés, pas de conversion de type), corps limités à 4 Ko.
- Chiffrement : `crypto.ts` (HKDF, HMAC, scrypt + poivre, comparaisons en temps constant), jeton patient (ES256, `iss`/`aud`/algorithme).
- Textes SMS (`i18n/fr.json`, `i18n/en.json`) : aucun lien, aucun établissement, aucune donnée médicale (F-JRN-02).
- Dépendances (`package.json`), `npm audit`, images signées (CI).

---

## 7. Ce qui a déjà été trouvé et corrigé (ne pas refaire)

Pour calibrer : ces points ont été reproduits, corrigés et couverts par un test qui échoue sans le correctif.

| Tour | Constats principaux |
|---|---|
| 1 (livraison) | Plafond horaire de codes qui comptait aussi les refus · champs inconnus supprimés en silence par Fastify · `sub` vide accepté · session inactive jamais fermée · pool de test saturé |
| 2 | `TRUST_PROXY=true` contournait la limitation par adresse · poste partagé sans contrôle d'appareil (→ restriction réseau) · numéro d'alerte modifiable côté Keycloak · PIN triviaux · enregistrement de numéros inconnus distinguable |
| 3 | Smartphone enrôlable depuis l'extérieur · proxy sans `TRUST_PROXY` = ouverture silencieuse · inondation d'alertes SMS (aucun plafond d'appareils) |
| 4 | **« Jamais d'appareil sans alerte » était faux** (sans numéro ou SMS en échec) · liste `TRUST_PROXY` erronée = ouverture silencieuse |
| Vérification | 22 contrôles cassés volontairement un à un : 22 détectés par les tests |

### Limites connues, déjà notées (`docs/DECISIONS.md`)
- Limite par adresse (30/min) à calibrer face aux réseaux mobiles qui partagent des adresses.
- Épuisement des quotas d'un numéro par un tiers (déni de service ciblé) : accepté, à documenter.
- Un attaquant qui détient déjà un appareil enrôlé n'est pas arrêté par la restriction réseau.
- `AUTH_ALLOWED_NETWORKS` doit désigner un réseau **dédié aux postes** (pas de Wi-Fi invité).
- Realm Keycloak, profil `phone_number` et démarrage complet : **non vérifiés**.
- Reconnaissance d'un système par son seul `azp` : à vérifier avec Keycloak (présence d'un `sid`).

---

## 8. Décisions à arbitrer par le porteur de projet

À cocher avant la validation du lot (détail dans `docs/DECISIONS.md`).

- [ ] **PIN vérifié côté serveur** (le dossier dit « PIN local ») : seul un compteur serveur est opposable ; PIN haché avec sel et poivre.
- [ ] **Un téléphone = un compte** : la connexion patient exige exactement un dossier actif portant ce numéro. Cas du téléphone familial (parent + enfants) à trancher, avec le lot L9.
- [ ] **Jetons patients émis par la passerelle** ; jetons des professionnels et des systèmes fournis par Keycloak.
- [ ] **Restriction réseau** des postes partagés et **enrôlement d'appareil réservé au réseau** de l'établissement ; enrôlement hors réseau (campagne) reporté au lot L3 (code d'enrôlement ou validation du directeur médical).
- [ ] **Numéro de téléphone obligatoire** pour tout professionnel (attribut `phone_number` dans Keycloak, modifiable par l'administrateur seulement).
- [ ] **Plafonds** : 5 appareils actifs et 5 enrôlements par heure par professionnel ; 5 codes SMS par heure par numéro. Compatibles avec le budget SMS (onglet 14) ?
- [ ] **Durées** : jeton d'accès 5 min, session patient 12 h, inactivité 15 / 30 min : conformes à l'usage terrain ?

---

## 9. Rapport de revue (modèle)

Un tableau par partie ; un problème = une ligne.

| # | Partie | Fichier:ligne | Gravité | Reproduit / déduit | Constat | Correction proposée |
|---|---|---|---|---|---|---|
| 1 | Autorisation | | bloquant / majeur / mineur | | | |

- **Bloquant** : compromet l'authentification ou expose des données ; le lot ne peut pas avancer.
- **Majeur** : contournement d'un contrôle documenté, ou défaillance silencieuse d'une mesure de sécurité.
- **Mineur** : qualité, lisibilité, durcissement, dette documentée.

---

## 10. Boucle de validation

1. Le relecteur remet son rapport (§9).
2. Les corrections sont faites **avec un test qui échoue sans le correctif**, puis relues.
3. **Le lot est validé** quand : (a) il ne reste aucun problème bloquant ni majeur ; (b) les décisions du §8 sont tranchées ; (c) la CI est verte ; (d) le realm Keycloak a été importé et le second facteur vérifié (jeton avec mot de passe seul refusé, jeton avec TOTP accepté).
4. Avant le pilote : **test d'intrusion indépendant** (onglet 6) et revue du lot par un expert externe (§10.5).

| Validation | Nom | Date | Décision |
|---|---|---|---|
| Relecteur | | | |
| Porteur de projet | | | |
