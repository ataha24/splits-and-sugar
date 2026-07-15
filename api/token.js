import { credentials, cookieHeader, stravaToken, json } from './_strava.js';

// Exchange the OAuth authorization code for tokens. The access token goes
// back to the page (memory only); the refresh token is set as an httpOnly
// cookie so the browser keeps the connection without the page ever seeing it.
export async function POST(request){
  const creds = credentials();
  if(!creds) return json({error: 'Server is missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET.'}, 500);

  const body = await request.json().catch(() => ({}));
  if(!body.code) return json({error: 'Missing authorization code.'}, 400);

  const tok = await stravaToken({
    client_id: creds.id,
    client_secret: creds.secret,
    code: body.code,
    grant_type: 'authorization_code'
  });
  if(!tok.ok || !tok.body.access_token){
    return json({error: 'Strava rejected the sign-in (' + tok.status + ') — try connecting again.'}, 502);
  }
  return json(
    {access_token: tok.body.access_token, expires_at: tok.body.expires_at},
    200,
    {'Set-Cookie': cookieHeader(tok.body.refresh_token)}
  );
}
