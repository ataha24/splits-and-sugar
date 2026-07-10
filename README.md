# Splits & Sugar

A single-page web app that combines a Strava run with Dexcom glucose data into one shareable report — pace, distance, and a glucose overlay chart showing how blood sugar moved before, during, and after the run.

**Live app:** https://ataha24.github.io/splits-and-sugar/

## How to use

1. **Connect Strava** — create a personal API app at [strava.com/settings/api](https://www.strava.com/settings/api) (one-time, ~2 min) and paste the access token shown there into the page. The page loads your 15 most recent runs; pick one.
2. **Add glucose data** — export a CSV from [Dexcom Clarity](https://clarity.dexcom.com) covering the day of the run, and upload it on the page.
3. **Generate the report** — you get an overlay chart, stats (distance, pace, avg glucose, range), and a copyable caption.

There's a **"Try it with demo data"** button if you just want to see what the report looks like.

## Privacy

- The whole app is one static HTML file — there is no backend and no storage.
- The Strava token is held in browser memory for the session only; it is never saved or sent anywhere except directly to Strava's API.
- The glucose CSV is parsed locally in the browser and never uploaded.

## Development

No build step. Open `index.html` in a browser, or serve it locally:

```sh
python3 -m http.server
```

Not a medical tool — just a fun way to see two data sets on one page.
