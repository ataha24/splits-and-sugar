import { credentials, json } from './_strava.js';

// Public app config for the front end. The client ID is public by design
// (it appears in the authorize URL); the secret never leaves the server.
export function GET(){
  const creds = credentials();
  if(!creds) return json({error: 'Server is missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET.'}, 500);
  return json({client_id: creds.id});
}
