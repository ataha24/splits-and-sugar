import { credentials, cookieHeader, clearCookieHeader, readRefreshCookie, stravaToken, json } from './_strava.js';

// Silent reconnect on return visits: swap the refresh token in the httpOnly
// cookie for a fresh access token. Strava rotates refresh tokens, so the
// cookie is re-set on every successful refresh.
export async function POST(request){
  const creds = credentials();
  if(!creds) return json({error: 'Server is missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET.'}, 500);

  const refreshToken = readRefreshCookie(request);
  if(!refreshToken) return json({error: 'Not connected.'}, 401);

  const tok = await stravaToken({
    client_id: creds.id,
    client_secret: creds.secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  if(!tok.ok || !tok.body.access_token){
    // stale or revoked connection — drop the cookie so we stop retrying
    return json({error: 'The saved connection expired — connect again.'}, 401, {'Set-Cookie': clearCookieHeader()});
  }
  return json(
    {access_token: tok.body.access_token, expires_at: tok.body.expires_at},
    200,
    {'Set-Cookie': cookieHeader(tok.body.refresh_token)}
  );
}
