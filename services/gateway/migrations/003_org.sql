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
  -- Écart avec le fournisseur d'identité à rattraper (reconcileDirectory) : activation ou désactivation distante échouée.
  directory_sync   text CHECK (directory_sync IN ('enable','disable')),
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
  revoked_by text,
  CHECK (role <> 'chef_service' OR service_id IS NOT NULL)      -- un chef de service l'est d'UN service
);
-- Cohérence rôle / compte / service, garantie même hors du service applicatif.
CREATE FUNCTION staff_role_guard() RETURNS trigger AS $$
DECLARE m staff_member%ROWTYPE; svc uuid;
BEGIN
  SELECT * INTO m FROM staff_member WHERE id = NEW.staff_id;
  IF NEW.role IN ('chef_district','superviseur_pev','operateur','administrateur_habilite') THEN
    IF m.establishment_id IS NOT NULL OR NEW.service_id IS NOT NULL THEN RAISE EXCEPTION 'rôle national : compte sans établissement ni service'; END IF;
    IF NEW.role = 'chef_district' AND m.district IS NULL THEN RAISE EXCEPTION 'chef de district : district requis'; END IF;
  ELSE
    IF m.establishment_id IS NULL THEN RAISE EXCEPTION 'rôle d''établissement : compte sans établissement'; END IF;
  END IF;
  IF NEW.service_id IS NOT NULL THEN
    SELECT establishment_id INTO svc FROM service_unit WHERE id = NEW.service_id;
    IF svc IS DISTINCT FROM m.establishment_id THEN RAISE EXCEPTION 'service d''un autre établissement'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_role_guard BEFORE INSERT ON staff_role FOR EACH ROW EXECUTE FUNCTION staff_role_guard();
-- Un rôle attribué ne se transforme pas (sinon un directeur deviendrait « opérateur » par un simple UPDATE, hors des contrôles
-- ci-dessus) : seule la révocation, une fois, est possible ; jamais de suppression.
CREATE FUNCTION staff_role_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'staff_role : suppression interdite (révoquer)'; END IF;
  IF (NEW.id, NEW.staff_id, NEW.role, NEW.service_id, NEW.granted_by, NEW.granted_at)
     IS DISTINCT FROM (OLD.id, OLD.staff_id, OLD.role, OLD.service_id, OLD.granted_by, OLD.granted_at) THEN
    RAISE EXCEPTION 'staff_role : seule la révocation est modifiable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'staff_role : rôle déjà révoqué';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_role_immutable BEFORE UPDATE OR DELETE ON staff_role FOR EACH ROW EXECUTE FUNCTION staff_role_immutable();
-- Rattachement d'un compte : identifiant fixe ; établissement et district ne changent pas sous des rôles actifs
-- (la cohérence rôle national / établissement vérifiée à l'attribution ne doit pas être défaite après coup).
CREATE FUNCTION staff_member_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'staff_member : suppression interdite (désactiver)'; END IF;
  IF NEW.id <> OLD.id OR NEW.sub <> OLD.sub THEN RAISE EXCEPTION 'staff_member : identifiant immuable'; END IF;
  IF NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
     AND EXISTS (SELECT 1 FROM staff_role WHERE staff_id = OLD.id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'staff_member : établissement figé tant que des rôles sont actifs';
  END IF;
  IF NEW.district IS DISTINCT FROM OLD.district
     AND EXISTS (SELECT 1 FROM staff_role WHERE staff_id = OLD.id AND revoked_at IS NULL AND role = 'chef_district') THEN
    RAISE EXCEPTION 'staff_member : district figé tant que le rôle de chef de district est actif';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_member_guard BEFORE UPDATE OR DELETE ON staff_member FOR EACH ROW EXECUTE FUNCTION staff_member_guard();
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
  CHECK ((reviewed_by IS NULL) = (review_outcome IS NULL)),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CHECK (review_outcome IS NULL OR review_required)                                 -- on ne contrôle que ce qui est à contrôler
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
CREATE FUNCTION statement_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% est en ajout seul', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER admin_action_no_truncate BEFORE TRUNCATE ON admin_action FOR EACH STATEMENT EXECUTE FUNCTION statement_append_only();

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
CREATE INDEX access_denial_actor_idx ON access_denial (actor_sub, at);
CREATE INDEX access_denial_patient_idx ON access_denial (patient_id) WHERE patient_id IS NOT NULL;
-- Ajout seul ; seule la purge de rétention (fonction ci-dessous, avant une date limite) peut supprimer des lignes.
CREATE FUNCTION access_denial_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('syfa.purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% est en ajout seul', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER access_denial_guard BEFORE UPDATE OR DELETE ON access_denial FOR EACH ROW EXECUTE FUNCTION access_denial_guard();
CREATE TRIGGER access_denial_no_truncate BEFORE TRUNCATE ON access_denial FOR EACH STATEMENT EXECUTE FUNCTION statement_append_only();
CREATE FUNCTION purge_access_denial(cutoff timestamptz) RETURNS bigint AS $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('syfa.purge', 'on', true);
  DELETE FROM access_denial WHERE at < cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('syfa.purge', 'off', true);
  RETURN n;
END;
$$ LANGUAGE plpgsql;
