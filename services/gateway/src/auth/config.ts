export type ClientClass = 'shared_pc' | 'smartphone' | 'patient_app';

/** Règles d'authentification (onglet 1 F-AUTH-01 à 04, onglet 6) : toutes paramétrables (principe 9). */
export interface AuthConfig {
  otp: { length: number; ttlSeconds: number; maxAttempts: number; resendMinSeconds: number; maxPerHour: number };
  pin: { length: number; maxAttempts: number };
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
  rateLimit: { ipPerMinute: number };
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const int = (k: string, d: number, min = 1) => {
    const v = env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new Error(`${k} doit être un entier >= ${min}`);
    return n;
  };
  const bool = (k: string, d: boolean) => (env[k] === undefined || env[k] === '' ? d : env[k] === 'true');
  const list = (k: string, d: string) => (env[k] ?? d).split(',').map((s) => s.trim()).filter(Boolean);

  const clientClasses: Record<string, ClientClass> = {};
  for (const pair of list('AUTH_CLIENT_CLASSES', 'syfa-web:shared_pc,syfa-android-pro:smartphone')) {
    const [client, cls] = pair.split(':');
    if (!client || !['shared_pc', 'smartphone'].includes(cls ?? '')) throw new Error(`AUTH_CLIENT_CLASSES invalide : ${pair}`);
    clientClasses[client] = cls as ClientClass;
  }
  const deviceRequiredClasses = list('AUTH_DEVICE_REQUIRED_CLASSES', 'smartphone');
  for (const c of deviceRequiredClasses) if (!['shared_pc', 'smartphone'].includes(c)) throw new Error(`AUTH_DEVICE_REQUIRED_CLASSES invalide : ${c}`);

  const cfg: AuthConfig = {
    otp: {
      length: int('AUTH_OTP_LENGTH', 6, 4),
      ttlSeconds: int('AUTH_OTP_TTL_SECONDS', 600),
      maxAttempts: int('AUTH_OTP_MAX_ATTEMPTS', 3),
      resendMinSeconds: int('AUTH_OTP_RESEND_MIN_SECONDS', 60),
      maxPerHour: int('AUTH_OTP_MAX_PER_HOUR', 5),
    },
    pin: { length: int('AUTH_PIN_LENGTH', 4, 4), maxAttempts: int('AUTH_PIN_MAX_ATTEMPTS', 5) },
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
    rateLimit: { ipPerMinute: int('AUTH_RATE_IP_PER_MINUTE', 30) },
  };
  if (cfg.accessTokenSeconds > cfg.idleSeconds.shared_pc) {
    throw new Error("AUTH_ACCESS_TOKEN_SECONDS ne doit pas dépasser l'inactivité d'un poste partagé");
  }
  return cfg;
}
