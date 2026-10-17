// OAuth2 Authorization Code Flow с PKCE: описание провайдеров и вызовы их API.
import { createHash, randomBytes } from 'node:crypto';

/** Провайдеры по умолчанию. Для тестов и нестандартных окружений поля переопределяются в конфигурации. */
export const PROVIDERS = {
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    authHeader: (token) => `Bearer ${token}`,
    parseProfile: (p) => ({ subject: String(p.sub ?? ''), email: String(p.email ?? '').toLowerCase(), emailVerified: p.email_verified === true, name: String(p.name ?? '') }),
  },
  yandex: {
    label: 'Яндекс ID',
    authorizeUrl: 'https://oauth.yandex.ru/authorize',
    tokenUrl: 'https://oauth.yandex.ru/token',
    userInfoUrl: 'https://login.yandex.ru/info?format=json',
    scope: 'login:email login:info',
    authHeader: (token) => `OAuth ${token}`,
    // Яндекс отдаёт default_email только при наличии права login:email; адрес считаем подтверждённым провайдером
    parseProfile: (p) => ({ subject: String(p.id ?? ''), email: String(p.default_email ?? '').toLowerCase(), emailVerified: Boolean(p.default_email), name: String(p.real_name ?? p.display_name ?? '') }),
  },
};

/** Собирает рабочие описания включённых провайдеров: берутся только те, для которых заданы Client ID и Secret. */
export function resolveProviders(config = {}) {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([, c]) => c?.clientId && c?.clientSecret)
      .map(([id, c]) => [id, { id, ...PROVIDERS[id], ...c.def, clientId: c.clientId, clientSecret: c.clientSecret }]),
  );
}

/** PKCE: случайный verifier и его SHA-256 challenge (RFC 7636). */
export function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function buildAuthUrl(p, redirectUri, state, challenge) {
  const url = new URL(p.authorizeUrl);
  const params = { response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri, scope: p.scope, state, code_challenge: challenge, code_challenge_method: 'S256' };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

const TIMEOUT_MS = 5000;

/** Обмен authorization code на access token. Бросает Error с безопасным сообщением (без секретов). */
export async function exchangeCode(p, redirectUri, code, verifier, fetchImpl = fetch) {
  const res = await fetchImpl(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: p.clientId, client_secret: p.clientSecret, code_verifier: verifier }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.access_token !== 'string') throw new Error(`token endpoint: HTTP ${res.status} ${String(data.error ?? '').slice(0, 60)}`);
  return data.access_token;
}

export async function fetchProfile(p, accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(p.userInfoUrl, { headers: { Authorization: p.authHeader(accessToken), Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`userinfo endpoint: HTTP ${res.status}`);
  return p.parseProfile(await res.json());
}
