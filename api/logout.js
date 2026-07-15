import { clearCookieHeader, json } from './_strava.js';

// Disconnect this browser: clear the refresh-token cookie.
export function POST(){
  return json({ok: true}, 200, {'Set-Cookie': clearCookieHeader()});
}
