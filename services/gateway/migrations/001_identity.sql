-- Base IDENTITÉ (onglet 3.2). Aucune donnée médicale ici (principe 2) :
-- le seul lien avec le serveur FHIR est patient.id (UUID technique).

-- Colonnes *_chiffre : AES-256-GCM applicatif (voir src/identity/crypto.ts).
-- Colonnes *_idx : index aveugles HMAC pour la recherche par égalité (aucune valeur en clair).
CREATE TABLE patient (
  id                 uuid PRIMARY KEY,
  nom_chiffre        text NOT NULL,                -- forme d'origine ; la forme normalisée est recalculée à la lecture
  prenoms_chiffre    text NOT NULL,
  nom_idx            text NOT NULL,                -- index aveugle de la clé phonétique du nom
  prenoms_idx        text NOT NULL,                -- idem pour les prénoms (même étiquette : tolère l'inversion)
  date_naissance_chiffre text NOT NULL,
  date_naissance_idx text NOT NULL,
  date_precision     text NOT NULL DEFAULT 'jour' CHECK (date_precision IN ('jour','mois','annee')),
  sexe               text NOT NULL CHECK (sexe IN ('F','M','I')),
  lieu_naissance_chiffre text,
  nom_mere_chiffre   text,
  nom_pere_chiffre   text,
  niveau_identite    smallint NOT NULL CHECK (niveau_identite IN (1,2,3)),
  telephone_chiffre  text,                         -- format 2376XXXXXXXX contrôlé par l'application
  telephone_idx      text,
  langue             text NOT NULL CHECK (langue IN ('fr','en')),
  contact_urgence_nom_chiffre       text,
  contact_urgence_telephone_chiffre text,
  localite_chiffre   text,
  photo_ref          text,
  statut_dossier     text NOT NULL DEFAULT 'actif'
                     CHECK (statut_dossier IN ('actif','provisoire','decede','fusionne')),
  merged_into        uuid REFERENCES patient(id),
  date_deces_chiffre text,
  created_at         timestamptz NOT NULL,
  -- lieu de naissance obligatoire pour les niveaux 2 et 3
  CONSTRAINT lieu_requis_niveau_2_3 CHECK (niveau_identite = 1 OR lieu_naissance_chiffre IS NOT NULL),
  -- un dossier fusionné pointe vers le dossier conservé, et seulement lui
  CONSTRAINT fusion_coherente CHECK ((statut_dossier = 'fusionne') = (merged_into IS NOT NULL)),
  CONSTRAINT pas_auto_fusion CHECK (merged_into IS NULL OR merged_into <> id)
);
CREATE INDEX patient_nom_idx ON patient (nom_idx);
CREATE INDEX patient_prenoms_dob_idx ON patient (prenoms_idx, date_naissance_idx);
CREATE INDEX patient_telephone_idx ON patient (telephone_idx);

CREATE TABLE patient_identifier (
  id            uuid PRIMARY KEY,
  patient_id    uuid NOT NULL REFERENCES patient(id),
  type          text NOT NULL CHECK (type IN ('csu','cni','acte')),
  valeur_chiffre text NOT NULL,
  valeur_idx    text NOT NULL,                     -- HMAC(type, valeur normalisée)
  created_at    timestamptz NOT NULL
);
-- CSU et CNI : unicité contrôlée. N° d'acte : non bloquant (onglet 3.2).
CREATE UNIQUE INDEX identifier_fort_unique ON patient_identifier (type, valeur_idx) WHERE type IN ('csu','cni');
CREATE INDEX identifier_patient_idx ON patient_identifier (patient_id);

CREATE TABLE representation_link (
  id                    uuid PRIMARY KEY,
  id_enfant             uuid NOT NULL REFERENCES patient(id),
  id_representant       uuid NOT NULL REFERENCES patient(id),
  type                  text NOT NULL CHECK (type IN ('pere','mere','tuteur')),
  document_justificatif text,
  date_debut            date NOT NULL,
  date_fin              date,
  statut                text NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif','retire','suspendu')),
  CHECK (id_enfant <> id_representant)
);
CREATE INDEX link_enfant_idx ON representation_link (id_enfant);
CREATE INDEX link_representant_idx ON representation_link (id_representant);

CREATE TABLE companion_delegation (
  id          uuid PRIMARY KEY,
  id_enfant   uuid NOT NULL REFERENCES patient(id),
  telephone_chiffre text NOT NULL,
  nom_chiffre       text NOT NULL,
  debut       timestamptz NOT NULL,
  fin         timestamptz NOT NULL,
  cree_par    text NOT NULL,
  CHECK (fin > debut)
);
CREATE INDEX delegation_enfant_idx ON companion_delegation (id_enfant);

-- Fusions : réversibles. `deplace` garde ce qui a été réaffecté pour pouvoir l'annuler.
CREATE TABLE patient_merge (
  id                uuid PRIMARY KEY,
  survivant_id      uuid NOT NULL REFERENCES patient(id),
  absorbe_id        uuid NOT NULL REFERENCES patient(id),
  statut_precedent  text NOT NULL,
  effectuee_par     text NOT NULL,
  motif             text NOT NULL,
  deplace           jsonb NOT NULL,
  references_fhir   jsonb NOT NULL DEFAULT '[]',
  -- Synchronisation avec le serveur FHIR : jamais perdue en silence.
  fhir_etat         text NOT NULL DEFAULT 'ok' CHECK (fhir_etat IN ('ok','en_attente','a_reconcilier')),
  fhir_operation    text CHECK (fhir_operation IN ('reassign','restore')),
  fhir_erreur       text,
  created_at        timestamptz NOT NULL,
  annulee_le        timestamptz,
  annulee_par       text,
  motif_annulation  text,
  CHECK (survivant_id <> absorbe_id)
);
-- au plus une fusion non annulée par dossier absorbé
CREATE UNIQUE INDEX merge_active_unique ON patient_merge (absorbe_id) WHERE annulee_le IS NULL;

-- Événements d'identité en ajout seul. Le journal infalsifiable chaîné par hachage
-- est livré au lot L11 ; cette table est la source qui lui sera raccordée.
CREATE TABLE identity_event (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  type        text NOT NULL,
  acteur      text NOT NULL,
  patient_id  uuid,
  details     jsonb NOT NULL DEFAULT '{}'
);
CREATE FUNCTION identity_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'identity_event est en ajout seul';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER identity_event_no_update BEFORE UPDATE OR DELETE ON identity_event
  FOR EACH ROW EXECUTE FUNCTION identity_event_append_only();
