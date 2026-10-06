# Tests de la passerelle

Un fichier par thème ; l'identifiant de l'exigence (F-AUTH-01, F-ID-03…) ou du point de revue (Q4, R5, S3, T5…) figure dans le titre de chaque groupe.

## Authentification (`auth/`)
| Fichier | Contenu |
|---|---|
| `otp.test.ts` | Code SMS : 6 chiffres, 10 min, 3 essais, usage unique, renvoi limité, numéro connu/inconnu indiscernable (F-AUTH-01) |
| `pin.test.ts` | PIN : 5 erreurs = nouveau SMS, PIN triviaux (F-AUTH-02) |
| `patient-sessions.test.ts` | Rafraîchissement, inactivité, durée absolue, perte de téléphone, journal d'authentification |
| `professional-auth.test.ts` | Second facteur (F-AUTH-03), inactivité 15/30 min (F-AUTH-04), systèmes |
| `devices.test.ts` | Appareils des professionnels : enregistrement, alerte, enrôlement réservé au réseau, plafonds |
| `network.test.ts` | Restriction réseau des postes partagés, confiance au reverse proxy |
| `rate-limit.test.ts` | Limitation de débit, quotas, corps limités, réponses d'erreur |
| `unit.test.ts` | Configuration, secrets, textes SMS |

## Identité (`identity/`)
| Fichier | Contenu |
|---|---|
| `matching.test.ts` | Normalisation, doublons, niveaux, ajout de CSU, journal, réglages du score (F-ID-01 à 03) |
| `validation-concurrence.test.ts` | Validation de saisie, courses sur un même CSU, interblocages |
| `merge.test.ts` | Fusion réversible, liens de représentation, décès |
| `fhir-sync.test.ts` | Synchronisation FHIR de la fusion : échecs, reprise, erreurs sans donnée sensible, ordre des verrous |
| `encryption.test.ts` | Chiffrement des colonnes sensibles, identifiants relus après fusion |
| `synthetic.test.ts` | 10 000 identités synthétiques : faux positifs et rappel |

## Lancer
```
npm test                                   # PGlite (PostgreSQL en WebAssembly) : 4 tests de concurrence ignorés
TEST_DATABASE_URL=postgres://… npm test    # PostgreSQL réel : tous les tests (utilisé par la CI)
```
`helpers.ts` (dans chaque dossier) fournit les environnements de test ; chaque test crée son propre schéma, rien n'est partagé.
