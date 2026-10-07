# Keycloak — realm `syfa` (lot L2)

Version de référence : **Keycloak 26.8.0** (`KEYCLOAK_IMAGE`, voir `infra/docker-compose.yml`). Relever la version seulement après avoir rejoué la vérification du §4 et l'avoir consignée au §5.

## 1. État de la vérification

| Point | État | Preuve |
|---|---|---|
| Import du realm (`syfa-realm.json`) | **Vérifié** — commit `69791cd`, Keycloak 26.8.0 | revue externe : realm importé, API OIDC 200, 3 clients, rôles, politique TOTP |
| `phone_number` : permissions du profil chargé | **Vérifié par l'API** (`view: admin,user` / `edit: admin`) | revue externe ; la **modification dans l'interface** n'a pas été testée |
| Flux « step-up » (`acr` 1 / 2) et refus / acceptation par la passerelle | **Non vérifié** — configuration écrite, jamais exécutée contre un vrai Keycloak | script testé seulement contre un Keycloak **simulé** (voir §3) |

Historique : premier import (`d834ac3`) en échec sur `unmanagedAttributePolicy: "DISABLED"` (valeur refusée : attendu `ENABLED`, `ADMIN_EDIT` ou `ADMIN_VIEW`) → clé retirée (`23965cd`) → import réussi (`69791cd`). Un « succès » antérieur venait d'un dossier de montage vide et ne comptait pas.

## 2. Ce que fournit `syfa-realm.json`
- **Clients** : `syfa-web` (poste partagé, PKCE S256, inactivité 15 min), `syfa-android-pro` (smartphone, 30 min), `syfa-system` (client credentials). Jeton d'accès 5 min, audience `syfa-gateway`, revendication `phone_number`. Les deux clients humains demandent le **niveau 2 par défaut** et l'imposent en **minimum** (`default.acr.values`, `minimum.acr.value` = `2`) : impossible d'obtenir un jeton de niveau 1.
- **Realm** : mot de passe de 12 caractères avec historique, blocage après 5 échecs, TOTP 6 chiffres / 30 s, rôles du dossier (onglet 2).
- **Profil utilisateur** : `phone_number` (format `2376XXXXXXXX`) modifiable par l'**administrateur seulement**. Il reçoit l'alerte « nouvel appareil » ; modifiable par l'utilisateur, un attaquant avec mot de passe et TOTP y mettrait son numéro. Chaque professionnel doit en avoir un : sans lui, l'enrôlement d'un appareil est refusé (409 `phone_required`).
- **Volontairement absents du JSON** : `authenticationFlows`, `authenticatorConfig`, `requiredActions`. Dans Keycloak 26.8.0 (`RealmManager.setupAuthenticationFlows` / `setupRequiredActions`), les flux et actions requises **par défaut** ne sont créés que si le realm importé n'en déclare **aucun**. Les déclarer dans le JSON ferait disparaître les flux standard ; l'ancien JSON, qui déclarait la seule `CONFIGURE_TOTP`, privait le realm de toutes les autres actions (changement de mot de passe, etc.). Le flux « step-up » est donc posé **après** l'import par le script du §3.

## 3. Le second facteur dans les jetons : « step-up » (F-AUTH-03)
La passerelle refuse tout jeton professionnel sans preuve de second facteur : `amr` contenant `otp`, **ou** `acr` ≥ `AUTH_MFA_ACR_MIN` (2 par défaut). Keycloak n'émet pas `amr` ; on utilise `acr`, que Keycloak calcule d'après le niveau d'authentification atteint (« 1 », « 2 », sans table de correspondance).

`configure-stepup.mjs` crée, de façon **idempotente**, ce flux (celui du guide « step-up » de Keycloak) et le lie au realm :

```
syfa-browser
 ├─ Cookie                                         ALTERNATIVE
 └─ syfa-browser-forms                             ALTERNATIVE
      ├─ syfa-level-1                              CONDITIONAL
      │    ├─ Condition – niveau 1 (max 36000 s)   REQUIRED
      │    └─ Username Password Form              REQUIRED
      └─ syfa-level-2                              CONDITIONAL
           ├─ Condition – niveau 2 (max 0 s)       REQUIRED   → OTP exigé à CHAQUE nouvelle connexion
           └─ OTP Form                             REQUIRED
```
Il active aussi `CONFIGURE_TOTP` comme action requise par défaut et **contrôle** les attributs de niveau des clients. Les noms d'appels et de paramètres (`loa-condition-level`, `loa-max-age`, `default.acr.values`, `minimum.acr.value`, requêtes d'administration) ont été relevés dans le **code source de Keycloak 26.8.0**.

```bash
make up                  # démarre l'authentification ; le service keycloak-setup applique le script
make keycloak-stepup     # (re)lance la configuration
make keycloak-check      # vérifie seulement ; code de sortie 1 si non conforme
# ou à la main :
KEYCLOAK_ADMIN_PASSWORD=… node infra/keycloak/configure-stepup.mjs [--check]
```
Un flux `syfa-browser` déjà présent mais **non conforme** n'est pas « réparé » en silence : le script le signale (le supprimer dans la console, puis relancer).

**Limites assumées** : tests du script contre un Keycloak **simulé** qui reproduit le comportement lu dans le code source (nouvelles exécutions `DISABLED`, priorités, `PUT {id, requirement, priority}`, alias uniques). Ils valident la logique, **pas** le comportement d'un vrai serveur.

## 4. Procédure de vérification (à faire avec un vrai Keycloak, puis à consigner au §5)
1. `make reset-db && make up` (le realm n'est importé qu'à sa **première** création ; `reset-db` supprime les volumes). Attendre la fin de `keycloak-setup` (`docker compose logs keycloak-setup`), puis `make keycloak-check` → *Conforme*.
2. Dans la console d'administration (realm `syfa`) : Authentication → le flux `syfa-browser` est lié comme « Browser flow ». Créer un utilisateur de test (rôle métier, `phone_number` = `237690000001`, mot de passe **non temporaire**).
3. **Second facteur dans le jeton** : `node scripts/kc-login.mjs --acr 2`, ouvrir l'adresse affichée, se connecter (mot de passe, puis configuration du TOTP à la première connexion). Attendus : `acr` = `"2"` ; la passerelle répond **HTTP 200** à `/v1/me` ; le script affiche *CONFORME*.
4. **Niveau 1 impossible** : `node scripts/kc-login.mjs --acr 1`. Attendu : Keycloak **réclame quand même le TOTP** et `acr` = `"2"` (le minimum relève la demande).
5. **Refus par la passerelle d'un jeton de niveau 1** : dans la console, client `syfa-web` → Advanced → retirer temporairement « Minimum ACR value », relancer `--acr 1` : attendus `acr` = `"1"` et passerelle **HTTP 401 `mfa_required`** (le script affiche *CONFORME*). **Remettre ensuite `2`** (ou `make reset-db`).
6. **`phone_number`** : en se connectant à la console du compte (`/realms/syfa/account`) avec l'utilisateur de test, vérifier que le champ n'est **pas modifiable**.
7. Si une étape échoue : relever le message exact de Keycloak (ou les claims affichés) et le consigner ci-dessous.

## 5. Journal de vérification (à compléter)
| Date | Version | Commit | Étapes 1–6 | Résultat |
|---|---|---|---|---|
| | | | | |

## 6. Hors périmètre du lot L2
- Second facteur de secours par SMS pour les professionnels (extension Keycloak à évaluer).
- TLS mutuel des systèmes : terminé par le reverse proxy (lot L18). La passerelle accepte les jetons « client credentials » des clients déclarés dans `AUTH_SYSTEM_CLIENTS` ; vérifier qu'ils ne portent ni `sid` ni `amr`, et ne jamais déclarer « système » un client servant à des connexions humaines.

## 7. Contrôles automatiques
`make test` et la CI exécutent `scripts/test/realm.test.mjs` (politique des attributs, `phone_number`, clients, TOTP, absence de flux déclarés, version épinglée), `scripts/test/keycloak-stepup.test.mjs` (script de configuration contre le Keycloak simulé) et `scripts/test/kc-login.test.mjs` (PKCE, échange du code, résultat attendu de la passerelle). Ils évitent de réintroduire les erreurs connues ; **ils ne remplacent pas la vérification du §4**.

## 8. Annuaire du personnel (lot L3) — non vérifié
La passerelle crée et désactive les comptes du personnel par l'API d'administration. Elle exige un client « compte de service » (hors du realm importé) :
1. Console → realm `syfa` → Clients → créer `syfa-directory`, authentification du client activée, « Service accounts roles » activé, flux standard / implicite / direct désactivés.
2. Onglet « Service account roles » : ajouter le rôle `manage-users` (et `view-users`) du client `realm-management`.
3. Renseigner `DIRECTORY_CLIENT_ID=syfa-directory` et `DIRECTORY_CLIENT_SECRET` (onglet Credentials) pour la passerelle.
4. Premier opérateur : créer le compte dans Keycloak (rôle métier `operateur`, `phone_number`), puis `npm run bootstrap-operator -- <sub>` (le `sub` est l'identifiant du compte).
5. Vérifier : créer un directeur par l'API, se connecter avec le mot de passe temporaire, constater que `phone_number` est conservé après une désactivation / réactivation.
