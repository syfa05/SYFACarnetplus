-- Authentification (lot L2). Aucune valeur secrète en clair : codes SMS, PIN, secrets d'appareil et jetons
-- de rafraîchissement ne sont stockés que sous forme d'empreintes clés (HMAC / scrypt avec poivre).

CREATE TABLE auth_otp (
  id          uuid PRIMARY KEY,
  patient_id  uuid REFERENCES patient(id),  -- NULL : code « fantôme » (numéro sans compte), jamais envoyé
  phone_idx   text NOT NULL,                 -- index aveugle du téléphone (même clé que la base identité)
  code_hash   text NOT NULL,                 -- HMAC(id, code)
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0,   -- essais comptés AVANT comparaison (pas de course possible)
  consumed_at timestamptz,
  superseded_at timestamptz                  -- un nouveau code invalide l'ancien
);
CREATE INDEX auth_otp_phone_idx ON auth_otp (phone_idx, created_at);

CREATE TABLE auth_patient_device (
  id           uuid PRIMARY KEY,
  patient_id   uuid NOT NULL REFERENCES patient(id),
  secret_hash  text NOT NULL,                -- SHA-256 d'un secret de 256 bits (jamais stocké en clair)
  pin_hash     text NOT NULL,                -- scrypt(HMAC(poivre, appareil|PIN))
  pin_attempts smallint NOT NULL DEFAULT 0,  -- tentatives depuis le dernier succès
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','sms_required','revoked')),
  label        text,
  created_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_reason text
);
CREATE INDEX auth_patient_device_patient_idx ON auth_patient_device (patient_id);

CREATE TABLE auth_session (
  id            text PRIMARY KEY,            -- patient : uuid ; professionnel : kc:<sid>:<client>
  kind          text NOT NULL CHECK (kind IN ('patient','professional')),
  subject       text NOT NULL,
  client_class text NOT NULL CHECK (client_class IN ('shared_pc','smartphone','patient_app')),
  device_id     text,
  refresh_hash  text,                        -- patients : jeton de rafraîchissement courant
  prev_refresh_hash text,                    -- précédent : sa réutilisation révoque la session
  created_at    timestamptz NOT NULL,
  last_activity timestamptz NOT NULL,
  expires_at    timestamptz,                 -- durée absolue (patients)
  revoked_at    timestamptz,
  revoked_reason text
);
CREATE INDEX auth_session_subject_idx ON auth_session (subject);
CREATE UNIQUE INDEX auth_session_refresh_idx ON auth_session (refresh_hash) WHERE refresh_hash IS NOT NULL;
CREATE INDEX auth_session_prev_refresh_idx ON auth_session (prev_refresh_hash) WHERE prev_refresh_hash IS NOT NULL;

CREATE TABLE auth_professional_device (
  id           uuid PRIMARY KEY,
  subject      text NOT NULL,
  key_hash     text NOT NULL,                -- HMAC de la clé d'appareil (générée sur l'appareil)
  label        text,
  -- pending : réservé, alerte pas encore confirmée (inutilisable) ; active : alerte envoyée ; revoked : définitif
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','revoked')),
  pending_since timestamptz,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  UNIQUE (subject, key_hash)
);

CREATE TABLE auth_rate_limit (
  key          text NOT NULL,
  window_start bigint NOT NULL,
  hits         integer NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Événements d'authentification, en ajout seul (raccordés au journal chaîné du lot L11).
-- Jamais de code, de PIN, de secret ni de jeton dans `details`.
CREATE TABLE auth_event (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL,
  type    text NOT NULL,
  subject text,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE FUNCTION auth_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'auth_event est en ajout seul';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER auth_event_no_update BEFORE UPDATE OR DELETE ON auth_event
  FOR EACH ROW EXECUTE FUNCTION auth_event_append_only();
