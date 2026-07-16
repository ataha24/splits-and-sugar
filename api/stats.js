import { readCounter, json } from './_strava.js';

// Public, anonymous stats for the landing page.
export async function GET(){
  const connections = await readCounter();
  if(connections === null) return json({error: 'Stats unavailable.'}, 503);
  return json({connections}, 200, {'Cache-Control': 's-maxage=60, stale-while-revalidate=300'});
}
