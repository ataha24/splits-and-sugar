// Shared helpers for the Strava auth endpoints. Files starting with "_" in
// /api are not deployed as endpoints, only bundled as imports.

export const COOKIE_NAME = 'ss_refresh';

// The refresh token lives in an httpOnly cookie: page JavaScript can never
// read it, so a compromised or malicious script on the page can't steal the
// user's Strava connection.
export function cookieHeader(refreshToken){
  return COOKIE_NAME + '=' + encodeURIComponent(refreshToken)
    + '; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=31536000';
}

export function clearCookieHeader(){
  return COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=0';
}

export function readRefreshCookie(request){
  const header = request.headers.get('cookie') || '';
  for(const part of header.split(';')){
    const [name, ...rest] = part.trim().split('=');
    if(name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function credentials(){
  const id = process.env.STRAVA_CLIENT_ID;
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if(!id || !secret) return null;
  return {id, secret};
}

export async function stravaToken(params){
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(params)
  });
  const body = await res.json().catch(() => ({}));
  return {ok: res.ok, status: res.status, body};
}

export function json(data, status = 200, extraHeaders = {}){
  return new Response(JSON.stringify(data), {
    status,
    headers: {'Content-Type': 'application/json', ...extraHeaders}
  });
}
