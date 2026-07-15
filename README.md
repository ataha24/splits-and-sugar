# Splits & Sugar

A single-page web app that combines a Strava run with Dexcom glucose data into one shareable report — pace, distance, and a glucose overlay chart showing how blood sugar moved before, during, and after the run.

**Live app:** https://ataha24.github.io/splits-and-sugar/

## How to use

1. **Connect Strava** — hit **Connect with Strava**, approve read-only access, and you're straight back on the page with your recent runs loaded — pick one. The browser stays connected on return visits until you hit disconnect. That's the whole setup.
2. **Add glucose data** — export a CSV from [clarity.dexcom.com](https://clarity.dexcom.com) covering the day of the run (export icon on any report page; the Clarity phone app can't export CSV, but the website works in a phone browser), then drag the file onto the page or click to choose it.
3. **Generate the report** — you get a glucose chart with the run window and target range marked, a time-in-range bar, stat tiles (distance, pace, HR, avg glucose, time in range), mile splits with per-mile glucose, earned badges, computed insights ("worth noticing"), a before/during/after story, a copyable caption, and a downloadable share image sized for Strava.

Want to see what a report looks like first? Check the [sample report](https://ataha24.github.io/splits-and-sugar/sample.html) — it's generated live from demo data.

## Privacy

- No account data is ever stored server-side. The tiny API layer (`/api`) only relays the OAuth token exchange to Strava — it holds the app's client secret in an environment variable and keeps nothing else.
- The page itself only ever sees the short-lived Strava access token, held in memory for the session. The long-lived refresh token lives in an httpOnly cookie, which page JavaScript cannot read — so there are no credentials in localStorage or anywhere a script could leak them. The **disconnect** link clears the cookie.
- The glucose CSV is parsed locally in the browser and never uploaded.

## Development

No build step. The static page can be served with `python3 -m http.server`, but the Strava connect flow needs the `/api` functions, so use:

```sh
vercel dev
```

## Running your own copy (owner setup, one-time)

1. Create a Strava API app at [strava.com/settings/api](https://www.strava.com/settings/api); set **Authorization Callback Domain** to your deployment's domain (e.g. `your-app.vercel.app`).
2. Deploy this repo to Vercel with two environment variables: `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`.
3. New Strava apps start in "single player mode" (only your own account can connect). Upgrade the athlete capacity from the [API settings dashboard](https://www.strava.com/settings/api) — up to 10 athletes is self-serve; beyond that requires submitting the app to Strava for review.

