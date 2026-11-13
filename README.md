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

**How it updates**
A GitHub Action (`.github/workflows/update.yml`) runs every ~5 minutes. It fetches the FAA feed and
Google News RSS (`scripts/fetch_status.py`) and redeploys the site to GitHub Pages. The app re-checks
every 60 seconds and whenever you reopen it. If the server data goes stale, the phone pulls headlines
directly from GDELT.

## Setup (one time)
1. In the repo, open **Settings → Pages** and set **Source = GitHub Actions**.
2. Open **Actions → Update flight status → Run workflow**. Scheduled runs only fire on the default branch.
3. Open `https://<your-user>.github.io/<repo>/` on your phone.
   - **iPhone:** Safari → Share → **Add to Home Screen**, open it from the home screen, then tap 🔔 to enable alerts (iOS 16.4+).
   - **Android:** Chrome → ⋮ → **Install app**, then tap 🔔.

## Limits
- Alerts fire while the app is open or recently in the background. True push while closed would need a push server.
- GitHub may run scheduled jobs less often than every 5 minutes when it's busy.
- Update the "Background" card by editing `app/data/briefing.json`.
