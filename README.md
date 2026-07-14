# Splits & Sugar

A single-page web app that combines a Strava run with Dexcom glucose data into one shareable report — pace, distance, and a glucose overlay chart showing how blood sugar moved before, during, and after the run.

**Live app:** https://ataha24.github.io/splits-and-sugar/

## How to use

1. **Connect Strava** — create a personal API app at [strava.com/settings/api](https://www.strava.com/settings/api) (one-time, ~2 min), set its **Authorization Callback Domain** to `ataha24.github.io`, then enter the app's Client ID and Client Secret on the page and hit **Connect with Strava**. Strava asks you to approve read-only access and sends you straight back; the page then loads your recent runs — pick one. With **Stay connected on this device** ticked (the default), return visits reconnect automatically — no re-entering anything. (Note: the "Your Access Token" shown on the settings page won't work directly — it lacks the scope to read activities — which is why the page does the proper authorization dance for you.)
2. **Add glucose data** — export a CSV from [clarity.dexcom.com](https://clarity.dexcom.com) covering the day of the run (export icon on any report page; the Clarity phone app can't export CSV, but the website works in a phone browser), then drag the file onto the page or click to choose it.
3. **Generate the report** — you get a glucose chart with the run window and target range marked, a time-in-range bar, stat tiles (distance, pace, HR, avg glucose, time in range), mile splits with per-mile glucose, earned badges, computed insights ("worth noticing"), a before/during/after story, a copyable caption, and a downloadable share image sized for Strava.

Want to see what a report looks like first? Check the [sample report](https://ataha24.github.io/splits-and-sugar/sample.html) — it's generated live from demo data.

## Privacy

- The app is fully static — there is no backend and no server-side storage. The OAuth token exchange happens in your browser, directly against Strava.
- With **Stay connected on this device** ticked, your Client ID/Secret and Strava refresh token are kept in your browser's localStorage (on your device only) so return visits reconnect automatically; the **disconnect** link removes them. Untick the box and nothing outlives the visit: the token stays in memory, and the Client ID/Secret survive only the OAuth redirect in sessionStorage before being wiped. Either way, credentials are never sent anywhere except directly to Strava's API.
- The glucose CSV is parsed locally in the browser and never uploaded.

## Development

No build step. Open `index.html` in a browser, or serve it locally:

```sh
python3 -m http.server
```

