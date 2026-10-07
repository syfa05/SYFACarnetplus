-- Établissements, personnel et rôles (lot L3). Aucune donnée médicale. Le nom et les coordonnées du personnel
-- restent dans le fournisseur d'identité : ici seulement l'identifiant du compte, l'établissement, les rôles.

CREATE TABLE establishment (
  id          uuid PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  district    text,                                  -- district de santé (chef de district : contrôle de niveau supérieur)
  -- Réseaux autorisés pour les postes partagés de CET établissement ; vide = liste globale de la passerelle.
  allowed_networks text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at  timestamptz NOT NULL,
  created_by  text NOT NULL
);

CREATE TABLE service_unit (
  id               uuid PRIMARY KEY,
  establishment_id uuid NOT NULL REFERENCES establishment(id),
  name             text NOT NULL,
  created_at       timestamptz NOT NULL,
  UNIQUE (establishment_id, name)
);

CREATE TABLE staff_member (
  id               uuid PRIMARY KEY,
  sub              text NOT NULL UNIQUE,             -- identifiant du compte dans le fournisseur d'identité (claim sub)
  establishment_id uuid REFERENCES establishment(id),-- NULL : opérateur, chef de district, administrateur national
  district         text,                             -- chef de district : district couvert
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at       timestamptz NOT NULL,
  created_by       text NOT NULL,
  disabled_at      timestamptz,
  disabled_by      text,
  disabled_reason  text
);
CREATE INDEX staff_member_establishment_idx ON staff_member (establishment_id);

CREATE TABLE staff_role (
  id         uuid PRIMARY KEY,
  staff_id   uuid NOT NULL REFERENCES staff_member(id),
  role       text NOT NULL CHECK (role IN ('secretaire','infirmier','medecin','directeur_medical','pharmacien','laboratoire',
                                           'chef_service','agent_emission','vaccinateur','chef_district','superviseur_pev',
                                           'operateur','administrateur_habilite')),
  service_id uuid REFERENCES service_unit(id),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text
);
-- Un même rôle, dans le même service, une seule fois à la fois.
CREATE UNIQUE INDEX staff_role_active_idx ON staff_role (staff_id, role, COALESCE(service_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at IS NULL;

-- Journal des actions d'administration, en ajout seul sauf la revue (une seule fois, par un autre que l'auteur).
CREATE TABLE admin_action (
  id               uuid PRIMARY KEY,
  at               timestamptz NOT NULL,
  actor_sub        text NOT NULL,
  actor_roles      text[] NOT NULL,
  action           text NOT NULL,
  establishment_id uuid REFERENCES establishment(id),
  district         text,
  target_sub       text,
  details          jsonb NOT NULL DEFAULT '{}',
  review_required  boolean NOT NULL DEFAULT false,
  reviewed_by      text,
  reviewed_at      timestamptz,
  review_outcome   text CHECK (review_outcome IN ('approved','contested')),
  review_comment   text,
  CHECK (reviewed_by IS NULL OR reviewed_by <> actor_sub),                         -- personne ne contrôle ses propres actions
  CHECK ((reviewed_by IS NULL) = (review_outcome IS NULL))
);
CREATE INDEX admin_action_review_idx ON admin_action (review_required, reviewed_at);
CREATE FUNCTION admin_action_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'admin_action est en ajout seul'; END IF;
  IF OLD.reviewed_by IS NOT NULL THEN RAISE EXCEPTION 'revue déjà faite'; END IF;
  IF (NEW.id, NEW.at, NEW.actor_sub, NEW.actor_roles, NEW.action, NEW.establishment_id, NEW.district, NEW.target_sub, NEW.details, NEW.review_required)
     IS DISTINCT FROM (OLD.id, OLD.at, OLD.actor_sub, OLD.actor_roles, OLD.action, OLD.establishment_id, OLD.district, OLD.target_sub, OLD.details, OLD.review_required) THEN
    RAISE EXCEPTION 'admin_action : seule la revue peut être renseignée';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER admin_action_guard BEFORE UPDATE OR DELETE ON admin_action FOR EACH ROW EXECUTE FUNCTION admin_action_guard();

-- Refus d'accès (tentatives journalisées, T-ACC-01/02) : jamais de contenu médical.
CREATE TABLE access_denial (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL,
  actor_sub        text,
  actor_kind       text NOT NULL,
  establishment_id uuid,
  patient_id       uuid,
  action           text NOT NULL,
  data             text NOT NULL,
  reason           text NOT NULL,
  condition        text
);
CREATE INDEX access_denial_at_idx ON access_denial (at);
CREATE FUNCTION row_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% est en ajout seul', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER access_denial_no_update BEFORE UPDATE OR DELETE ON access_denial
  FOR EACH ROW EXECUTE FUNCTION row_append_only();
