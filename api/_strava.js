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

// A single anonymous total-connections counter in Upstash Redis — the only
// thing the app ever stores, and it contains nothing about any user.
function kvConfig(){
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? {url, token} : null;
}

export async function bumpCounter(){
  const kv = kvConfig();
  if(!kv) return;
  try{
    await fetch(kv.url + '/incr/ss_connections', {headers: {Authorization: 'Bearer ' + kv.token}});
  }catch(_){ /* counting must never break sign-in */ }
}

export async function readCounter(){
  const kv = kvConfig();
  if(!kv) return null;
  try{
    const res = await fetch(kv.url + '/get/ss_connections', {headers: {Authorization: 'Bearer ' + kv.token}});
    const data = await res.json();
    return data.result === null ? 0 : parseInt(data.result, 10);
  }catch(_){
    return null;
  }
}

export function json(data, status = 200, extraHeaders = {}){
  return new Response(JSON.stringify(data), {
    status,
    headers: {'Content-Type': 'application/json', ...extraHeaders}
  });
}
