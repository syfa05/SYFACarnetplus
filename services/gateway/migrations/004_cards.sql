-- Cartes santé (lot L4). Base identité : aucune donnée médicale. Le QR code (« CS1:… ») et le code de secours ne sont
-- jamais stockés en clair : chiffrés (la carte numérique de l'application doit pouvoir les réafficher) + index aveugles pour
-- la recherche, + empreintes SHA-256 pour la liste des cartes révoquées envoyée aux serveurs locaux et aux appareils.

CREATE TABLE card (
  id               uuid PRIMARY KEY,
  patient_id       uuid REFERENCES patient(id),            -- NULL : carte de réserve, pas encore attribuée
  type             text NOT NULL CHECK (type IN ('adulte','enfant','temporaire')),
  number           text NOT NULL UNIQUE,                    -- CS-2026-0004817 / CE-… / CT-…
  status           text NOT NULL CHECK (status IN ('reservee','emise','active','bloquee','revoquee')),
  token_enc        text NOT NULL,
  token_idx        text NOT NULL UNIQUE,
  token_sha        text NOT NULL,
  code_enc         text NOT NULL,
  code_idx         text NOT NULL UNIQUE,
  code_sha         text NOT NULL,
  establishment_id uuid REFERENCES establishment(id),       -- établissement émetteur
  issued_by        text,
  issued_at        timestamptz,
  activation_deadline timestamptz,                          -- au-delà, la carte non activée est révoquée
  activated_by     text,
  activated_at     timestamptz,
  reserve_device   uuid REFERENCES auth_professional_device(id),
  blocked_at       timestamptz,
  blocked_by       text,
  blocked_reason   text,
  revoked_at       timestamptz,
  revoked_reason   text,
  created_at       timestamptz NOT NULL,
  CHECK (status NOT IN ('emise','active','bloquee') OR patient_id IS NOT NULL),
  CHECK (status <> 'reservee' OR (patient_id IS NULL AND reserve_device IS NOT NULL))
);
-- UNE SEULE carte active par patient, garanti par la base.
CREATE UNIQUE INDEX card_one_active_per_patient ON card (patient_id) WHERE status = 'active';
CREATE INDEX card_patient_idx ON card (patient_id);
CREATE INDEX card_deadline_idx ON card (activation_deadline) WHERE status = 'emise';
CREATE INDEX card_reserve_idx ON card (reserve_device) WHERE status = 'reservee';

-- Numéros de carte : un compteur par préfixe et par année (jamais réutilisé).
CREATE TABLE card_counter (
  prefix text NOT NULL,
  year   integer NOT NULL,
  n      integer NOT NULL,
  PRIMARY KEY (prefix, year)
);

-- Journal des cartes (émission, activation, blocage, révocation, scans refusés), en ajout seul.
CREATE TABLE card_event (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL,
  card_id          uuid,
  patient_id       uuid,
  type             text NOT NULL,
  actor_sub        text,
  actor_kind       text NOT NULL,
  establishment_id uuid,
  details          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX card_event_card_idx ON card_event (card_id);
CREATE INDEX card_event_at_idx ON card_event (at);
CREATE TRIGGER card_event_append_only BEFORE UPDATE OR DELETE ON card_event FOR EACH ROW EXECUTE FUNCTION statement_append_only();
CREATE TRIGGER card_event_no_truncate BEFORE TRUNCATE ON card_event FOR EACH STATEMENT EXECUTE FUNCTION statement_append_only();

-- Liste des cartes révoquées (cartes bloquées ou révoquées), incrémentale : `seq` croît, les appareils redemandent « depuis seq ».
-- Empreintes SHA-256 seulement : une carte révoquée ne peut plus servir, la liste ne révèle aucun identifiant utilisable.
CREATE TABLE card_revocation (
  seq        bigserial PRIMARY KEY,
  card_id    uuid NOT NULL,
  token_sha  text NOT NULL,
  code_sha   text NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('bloquee','revoquee')),
  at         timestamptz NOT NULL
);
CREATE TRIGGER card_revocation_append_only BEFORE UPDATE OR DELETE ON card_revocation FOR EACH ROW EXECUTE FUNCTION statement_append_only();
CREATE TRIGGER card_revocation_no_truncate BEFORE TRUNCATE ON card_revocation FOR EACH STATEMENT EXECUTE FUNCTION statement_append_only();

-- Règles de la carte garanties en base, quel que soit le code appelant :
--  - identifiants, numéro, type et empreintes immuables ; le patient ne change pas une fois attribué ;
--  - transitions permises seulement : réservée → émise|active|révoquée ; émise → active|bloquée|révoquée ;
--    active → bloquée|révoquée ; bloquée → révoquée ; révoquée : définitif ;
--  - toute entrée en « bloquée » ou « révoquée » ajoute la carte à la liste des révoquées (impossible de l'oublier) ;
--  - jamais de suppression.
CREATE FUNCTION card_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'card : suppression interdite (révoquer)'; END IF;
  IF (NEW.id, NEW.number, NEW.type, NEW.token_enc, NEW.token_idx, NEW.token_sha, NEW.code_enc, NEW.code_idx, NEW.code_sha)
     IS DISTINCT FROM (OLD.id, OLD.number, OLD.type, OLD.token_enc, OLD.token_idx, OLD.token_sha, OLD.code_enc, OLD.code_idx, OLD.code_sha) THEN
    RAISE EXCEPTION 'card : identifiants immuables';
  END IF;
  IF OLD.patient_id IS NOT NULL AND NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN RAISE EXCEPTION 'card : patient immuable'; END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'reservee' AND NEW.status IN ('emise','active','revoquee')) OR
       (OLD.status = 'emise'    AND NEW.status IN ('active','bloquee','revoquee')) OR
       (OLD.status = 'active'   AND NEW.status IN ('bloquee','revoquee')) OR
       (OLD.status = 'bloquee'  AND NEW.status = 'revoquee')) THEN
    RAISE EXCEPTION 'card : transition % -> % interdite', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'revoquee' AND NEW.status = 'revoquee' AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'card : déjà révoquée';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER card_guard BEFORE UPDATE OR DELETE ON card FOR EACH ROW EXECUTE FUNCTION card_guard();

CREATE FUNCTION card_to_revocation_list() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('bloquee','revoquee') AND NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO card_revocation (card_id, token_sha, code_sha, reason, at) VALUES (NEW.id, NEW.token_sha, NEW.code_sha, NEW.status, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER card_to_revocation_list AFTER UPDATE ON card FOR EACH ROW EXECUTE FUNCTION card_to_revocation_list();

-- Appareil d'émission perdu ou volé (révoqué par n'importe quel chemin : propriétaire, directeur, désactivation du compte) :
-- sa réserve de codes non utilisés est annulée immédiatement (onglet 5.6).
CREATE FUNCTION card_cancel_device_reserve() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' THEN
    INSERT INTO card_event (at, card_id, type, actor_kind, details)
      SELECT now(), id, 'reserve_cancelled', 'system', '{"raison":"appareil_perdu"}'::jsonb FROM card WHERE reserve_device = NEW.id AND status = 'reservee';
    UPDATE card SET status = 'revoquee', revoked_at = now(), revoked_reason = 'appareil_perdu' WHERE reserve_device = NEW.id AND status = 'reservee';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER card_cancel_device_reserve AFTER UPDATE ON auth_professional_device FOR EACH ROW EXECUTE FUNCTION card_cancel_device_reserve();
