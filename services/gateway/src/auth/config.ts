import { parseBool, parseIntStrict } from '../env.js';
import { parseCidr } from './network.js';

export type ClientClass = 'shared_pc' | 'smartphone' | 'patient_app';

/** Règles d'authentification (onglet 1 F-AUTH-01 à 04, onglet 6) : toutes paramétrables (principe 9). */
export interface AuthConfig {
  otp: {
    length: number; ttlSeconds: number; maxAttempts: number; resendMinSeconds: number;
    /** Demandes de code acceptées par numéro et par fenêtre de quota (SMS réellement envoyés). */
    maxPerHour: number;
    maxVerifyPerHour: number;
    quotaWindowSeconds: number;
  };
  pin: { length: number; maxAttempts: number; rejectWeak: boolean };
  /** Inactivité maximale par type de client. */
  idleSeconds: Record<ClientClass, number>;
  accessTokenSeconds: number;
  patientSessionMaxSeconds: number;
  /** Client OIDC (azp) → type de client. Un client inconnu est refusé. */
  clientClasses: Record<string, ClientClass>;
  /** Clients « système » (client credentials) : pas de second facteur ni de session. */
  systemClients: string[];
  /** Classes de client exigeant un appareil enregistré. */
  deviceRequiredClasses: ClientClass[];
  mfa: { amr: string; acrMin: number };
  patientIssuer: string;
  patientAudience: string;
  revokeOtherDevicesOnEnrol: boolean;
  alertOnFirstProfessionalDevice: boolean;
  rateLimit: { ipLimit: number; ipWindowSeconds: number };
  /**
   * Restriction réseau (onglet 6.2, usurpation d'un compte) : les clients de ces types (postes partagés des
   * établissements) ne sont acceptés que depuis les réseaux autorisés. Les smartphones, mobiles par nature,
   * sont couverts par l'enregistrement d'appareil.
   */
  networkRestrictedClasses: ClientClass[];
  allowedNetworks: string[];
  /**
   * Enrôlement d'un appareil professionnel : réservé aux réseaux autorisés (remise de l'appareil à l'établissement).
   * Sans cela, des identifiants et un TOTP volés permettraient d'enregistrer un appareil de n'importe où.
   * À ne désactiver que lorsqu'un code d'enrôlement remis par l'établissement existera (lot L3).
   */
  deviceEnrolmentNetworkOnly: boolean;
  /** Appareils actifs par professionnel, et nouveaux enregistrements par fenêtre (chacun déclenche un SMS d'alerte). */
  device: {
    maxActive: number; registrationsPerWindow: number; registrationWindowSeconds: number;
    /** Un enrôlement « en attente » plus ancien (crash entre l'alerte et l'activation) ne compte plus dans le plafond. */
    pendingSeconds: number;
  };
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const int = (k: string, d: number, min = 1) => parseIntStrict(env, k, d, min);
  const bool = (k: string, d: boolean) => parseBool(env, k, d);
  const list = (k: string, d: string) => (env[k] ?? d).split(',').map((s) => s.trim()).filter(Boolean);

  const clientClasses: Record<string, ClientClass> = {};
  for (const pair of list('AUTH_CLIENT_CLASSES', 'syfa-web:shared_pc,syfa-android-pro:smartphone')) {
    const [client, cls] = pair.split(':');
    if (!client || !['shared_pc', 'smartphone'].includes(cls ?? '')) throw new Error(`AUTH_CLIENT_CLASSES invalide : ${pair}`);
    clientClasses[client] = cls as ClientClass;
  }
  const deviceRequiredClasses = list('AUTH_DEVICE_REQUIRED_CLASSES', 'smartphone');
  for (const c of deviceRequiredClasses) if (!['shared_pc', 'smartphone'].includes(c)) throw new Error(`AUTH_DEVICE_REQUIRED_CLASSES invalide : ${c}`);

  const restricted = list('AUTH_NETWORK_RESTRICTED_CLASSES', 'shared_pc');
  for (const c of restricted) if (!['shared_pc', 'smartphone'].includes(c)) throw new Error(`AUTH_NETWORK_RESTRICTED_CLASSES invalide : ${c}`);

  const cfg: AuthConfig = {
    otp: {
      length: int('AUTH_OTP_LENGTH', 6, 4),
      ttlSeconds: int('AUTH_OTP_TTL_SECONDS', 600),
      maxAttempts: int('AUTH_OTP_MAX_ATTEMPTS', 3),
      resendMinSeconds: int('AUTH_OTP_RESEND_MIN_SECONDS', 60),
      maxPerHour: int('AUTH_OTP_MAX_PER_HOUR', 5),
      maxVerifyPerHour: int('AUTH_OTP_MAX_VERIFY_PER_HOUR', 30),
      quotaWindowSeconds: int('AUTH_OTP_QUOTA_WINDOW_SECONDS', 3600),
    },
    pin: { length: int('AUTH_PIN_LENGTH', 4, 4), maxAttempts: int('AUTH_PIN_MAX_ATTEMPTS', 5), rejectWeak: bool('AUTH_PIN_REJECT_WEAK', true) },
    idleSeconds: {
      shared_pc: int('AUTH_IDLE_SHARED_PC_SECONDS', 15 * 60),
      smartphone: int('AUTH_IDLE_SMARTPHONE_SECONDS', 30 * 60),
      patient_app: int('AUTH_IDLE_PATIENT_SECONDS', 30 * 60),
    },
    accessTokenSeconds: int('AUTH_ACCESS_TOKEN_SECONDS', 5 * 60),
    patientSessionMaxSeconds: int('AUTH_PATIENT_SESSION_MAX_SECONDS', 12 * 3600),
    clientClasses,
    systemClients: list('AUTH_SYSTEM_CLIENTS', ''),
    deviceRequiredClasses: deviceRequiredClasses as ClientClass[],
    mfa: { amr: env.AUTH_MFA_AMR ?? 'otp', acrMin: int('AUTH_MFA_ACR_MIN', 2) },
    patientIssuer: env.AUTH_PATIENT_ISSUER ?? 'urn:syfa:gateway',
    patientAudience: env.AUTH_PATIENT_AUDIENCE ?? 'syfa-patient',
    revokeOtherDevicesOnEnrol: bool('AUTH_REVOKE_OTHER_DEVICES_ON_ENROL', true),
    alertOnFirstProfessionalDevice: bool('AUTH_ALERT_ON_FIRST_DEVICE', true),
    rateLimit: { ipLimit: int('AUTH_RATE_IP_PER_MINUTE', 30), ipWindowSeconds: int('AUTH_RATE_IP_WINDOW_SECONDS', 60) },
    networkRestrictedClasses: restricted as ClientClass[],
    allowedNetworks: list('AUTH_ALLOWED_NETWORKS', '127.0.0.0/8,::1/128'),
    deviceEnrolmentNetworkOnly: bool('AUTH_DEVICE_ENROLMENT_NETWORK_ONLY', true),
    device: {
      maxActive: int('AUTH_DEVICE_MAX_ACTIVE', 5),
      registrationsPerWindow: int('AUTH_DEVICE_REGISTRATIONS_PER_WINDOW', 5),
      registrationWindowSeconds: int('AUTH_DEVICE_REGISTRATION_WINDOW_SECONDS', 3600),
      pendingSeconds: int('AUTH_DEVICE_PENDING_SECONDS', 300),
    },
  };
  for (const n of cfg.allowedNetworks) {
    // « tout Internet » n'est pas une restriction : si c'est voulu, vider AUTH_NETWORK_RESTRICTED_CLASSES (et le dire).
    if (parseCidr(n).prefix === 0) throw new Error(`AUTH_ALLOWED_NETWORKS : ${n} autorise tout le réseau ; vider AUTH_NETWORK_RESTRICTED_CLASSES si c'est voulu`);
  }
  if (cfg.networkRestrictedClasses.length && !cfg.allowedNetworks.length) {
    throw new Error('AUTH_ALLOWED_NETWORKS ne peut pas être vide quand des clients sont restreints au réseau');
  }
  if (cfg.accessTokenSeconds > cfg.idleSeconds.shared_pc) {
    throw new Error("AUTH_ACCESS_TOKEN_SECONDS ne doit pas dépasser l'inactivité d'un poste partagé");
  }
  return cfg;
}
