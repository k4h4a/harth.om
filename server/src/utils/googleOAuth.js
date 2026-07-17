const { OAuth2Client } = require("google-auth-library");
const env = require("../config/env");

function client() {
  return new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_CALLBACK_URL,
  );
}

function isConfigured() {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL,
  );
}

/**
 * Build the URL that starts Google's consent screen. `state` is round-tripped
 * back to us on the callback for CSRF verification (see utils/jwt.js).
 */
function getAuthUrl(state) {
  return client().generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
}

/**
 * Exchanges an authorization code for tokens, verifies the ID token's
 * signature/audience/expiry against Google's public keys, and returns only
 * the profile fields we trust and need. Throws if the code is invalid or the
 * email isn't Google-verified — callers must not fall back to trusting the
 * code/token themselves.
 */
async function getProfileFromCode(code) {
  const oauth2Client = client();
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.id_token) {
    throw new Error("Google did not return an ID token");
  }

  const ticket = await oauth2Client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.email_verified) {
    throw new Error("Google account email is not verified");
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email,
    picture: payload.picture || null,
  };
}

module.exports = { isConfigured, getAuthUrl, getProfileFromCode };
