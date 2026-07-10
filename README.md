# Splits & Sugar

A single-page web app that combines a Strava run with Dexcom glucose data into one shareable report — pace, distance, and a glucose overlay chart showing how blood sugar moved before, during, and after the run.

**Live app:** https://ataha24.github.io/splits-and-sugar/

## How to use

1. **Connect Strava** — create a personal API app at [strava.com/settings/api](https://www.strava.com/settings/api) (one-time, ~2 min), set its **Authorization Callback Domain** to `ataha24.github.io`, then enter the app's Client ID and Client Secret on the page and hit **Connect with Strava**. Strava asks you to approve read-only access and sends you straight back; the page then loads your recent runs — pick one. (Note: the "Your Access Token" shown on the settings page won't work directly — it lacks the scope to read activities — which is why the page does the proper authorization dance for you.)
2. **Add glucose data** — export a CSV from [Dexcom Clarity](https://clarity.dexcom.com) covering the day of the run, and upload it on the page.
3. **Generate the report** — you get a glucose chart with the run window and target range marked, stat tiles (distance, pace, HR, avg glucose, time in range), mile splits, a before/during/after story, and a copyable caption.

There's a **"Try it with demo data"** button if you just want to see what the report looks like.

## Privacy

- The app is fully static — there is no backend and no storage. The OAuth token exchange happens in your browser, directly against Strava.
- The Strava token is held in browser memory for the session only; it is never saved or sent anywhere except directly to Strava's API. The Client ID/Secret survive the OAuth redirect in sessionStorage and are wiped the moment the page returns.
- The glucose CSV is parsed locally in the browser and never uploaded.

## Development

No build step. Open `index.html` in a browser, or serve it locally:

```sh
python3 -m http.server
```

