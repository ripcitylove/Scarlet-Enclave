# Ground Stop Watch

A lightweight phone app (installable web app, works on iPhone and Android) that tracks the
FAA ground stop and the air traffic control communications outage.

**What it shows**
- A color-coded status banner (Normal → Critical) built from the live FAA NAS Status feed
- Ground stops, ground delay programs, closures and arrival/departure delays by airport
- "My airports": your airports are pinned and highlighted
- Latest news headlines on the outage, with new ones marked
- Alerts (phone notifications and vibration) when the status level changes, a watched airport gets a ground stop, or new headlines arrive
- Links to the FAA, airline advisory pages, and DOT refund rights

**How it updates (about every 60 seconds)**
- **Server:** `.github/workflows/update.yml` runs a continuous loop. Every 60 seconds it fetches the FAA feed
  and Google News (`scripts/fetch_status.py`) and pushes to the `live` branch whenever anything changes.
- **Phone:** every 60 seconds while the app is open, it pulls the newest FAA data from GitHub and fetches
  live news (GDELT) and public posts (Bluesky, Mastodon) itself, so breaking items don't wait on the server.
  It also refreshes the moment you reopen the app or reconnect.
- New items get a NEW badge. Alerts fire for status changes, ground stops at your airports, and new news
  headlines (social posts too if you tick "Alert on social").

## Open it on your phone
**https://raw.githack.com/ripcitylove/Scarlet-Enclave/live/index.html?v=3**

No settings needed: raw.githack.com serves the `live` branch as a web page. Optionally, you can instead
use GitHub Pages: Settings → Pages → Deploy from a branch → `live` / root.

- **iPhone:** Safari → Share → **Add to Home Screen**, open it from the home screen, then tap 🔔 (iOS 16.4+).
- **Android:** Chrome → ⋮ → **Install app** (or Add to Home screen), then tap 🔔.

## Limits
- Alerts fire while the app is open or recently in the background. True push while closed would need a push server.
- If GitHub delays the scheduled job, the phone's direct live sources keep the feed moving; the banner warns when FAA data is over 15 minutes old.
- Update the "Background" card by editing `app/data/briefing.json`.
