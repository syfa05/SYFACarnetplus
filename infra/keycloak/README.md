# Keycloak — realm `syfa` (lot L2)

> **Non vérifié** : ce realm n'a pas pu être importé dans un Keycloak réel pendant le développement du lot L2
> (pas de démon Docker ni d'accès aux images dans l'environnement de travail). Le contrôle de la passerelle est
> testé avec des jetons synthétiques ; **l'étape ci-dessous reste à faire et à tester** avant tout usage.

## Ce que fournit `syfa-realm.json`
- Clients : `syfa-web` (poste partagé, PKCE S256, inactivité 15 min), `syfa-android-pro` (smartphone, 30 min),
  `syfa-system` (client credentials, systèmes tiers). Jeton d'accès 5 min, audience `syfa-gateway`, `phone_number`.
- Mot de passe : 12 caractères, historique 5 ; blocage après 5 échecs ; TOTP 6 chiffres / 30 s ;
  action requise `CONFIGURE_TOTP` par défaut.
- Rôles du dossier (onglet 2).

## Ce qui reste à configurer : le second facteur DANS les jetons (F-AUTH-03)
La passerelle refuse tout jeton professionnel sans preuve de second facteur : `amr` contenant `otp`, **ou**
`acr` ≥ `AUTH_MFA_ACR_MIN` (2 par défaut). Keycloak n'émet pas `amr` nativement ; il faut donc l'authentification
« step-up » :
1. Créer un flux navigateur avec deux niveaux (« Condition — Level of Authentication » : niveau 1 = identifiant +
   mot de passe, niveau 2 = formulaire OTP) et le lier au realm ;
2. Définir la correspondance ACR → niveau (`acr.loa.map` = `{"1":1,"2":2}`) et faire demander `acr_values=2` par
   les clients `syfa-web` et `syfa-android-pro` ;
3. Vérifier qu'un jeton obtenu avec mot de passe seul porte `acr=1` (refusé par la passerelle) et qu'un jeton
   obtenu avec TOTP porte `acr=2` (accepté).

Tant que cette étape n'est pas faite, **aucun professionnel ne peut se connecter** : c'est voulu (refus par défaut).

## Non couvert par le lot L2
- Second facteur de secours par SMS pour les professionnels (nécessite une extension Keycloak — à évaluer).
- TLS mutuel pour les systèmes : terminé par le reverse proxy (lot L18) ; la passerelle accepte aujourd'hui les
  jetons « client credentials » des clients déclarés dans `AUTH_SYSTEM_CLIENTS`.
