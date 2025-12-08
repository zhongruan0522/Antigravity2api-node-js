import axios from 'axios';
import config from '../config/config.js';

// NOTE:
// OAuth client configuration is shared between CLI login script and HTTP server.
// For now we keep the built‑in defaults and allow overriding via env when needed.

export const CLIENT_ID = config.oauth.clientId;
export const CLIENT_SECRET = config.oauth.clientSecret;

export const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];

/**
 * Build Google OAuth consent URL.
 * @param {string} redirectUri - redirect_uri registered in OAuth client
 * @param {string} state - CSRF protection / opaque state
 */
export function buildAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: CLIENT_ID,
    prompt: 'consent',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens via Google OAuth endpoint.
 * Uses axios and respects global timeout / proxy config.
 * @param {string} code - authorization code
 * @param {string} redirectUri - must match the one used in buildAuthUrl
 */
export async function exchangeCodeForToken(code, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  if (CLIENT_SECRET) {
    body.append('client_secret', CLIENT_SECRET);
  }

  const axiosConfig = {
    method: 'POST',
    url: 'https://oauth2.googleapis.com/token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    data: body.toString(),
    timeout: config.timeout,
    proxy: config.proxy
      ? (() => {
          const proxyUrl = new URL(config.proxy);
          return {
            protocol: proxyUrl.protocol.replace(':', ''),
            host: proxyUrl.hostname,
            port: parseInt(proxyUrl.port)
          };
        })()
      : false
  };

  const res = await axios(axiosConfig);
  return res.data;
}

