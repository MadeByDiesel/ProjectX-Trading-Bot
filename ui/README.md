Here’s the quickest way to get it running.

## 1) Put the file in place

* Save the Alpine page I gave you as `ui/index.html`.

## 2) Run your API

* Start your API on **[http://localhost:4001](http://localhost:4001)** (as in your server file).
* Make sure these endpoints exist and return JSON:

  * `GET /api/accounts`
  * `GET /api/strategy/status`
  * `POST /api/strategy/start`
  * `POST /api/strategy/stop`
  * `GET /api/strategy/config`
  * `PUT /api/strategy/config` (accept only the 16 fields + `breakoutLookbackBars`, return `effective` and an `ETag` or `version`)
* Your CORS is already `origin: 'http://localhost:4000'` — keep that.

## 3) Serve the UI on port 4000

From the `ui/` folder, pick one:

* Node:
  `npx serve -l 4000 .`
* Python:
  `python3 -m http.server 4000`

Open: **[http://localhost:4000](http://localhost:4000)**

*(If you change the port, update the `BASE` constant in the HTML script or the API’s CORS origin.)*

## 4) Use the UI (flow)

1. **Accounts** load automatically → pick one → **Confirm Account** (shows it in the header).
   *(Selection isn’t persisted server-side; the account is passed in the body to `/api/strategy/start`.)*
2. **CONFIGURATION** tab:

   * Edit any of the 16 fields (times, EMA/HTF, delta, ATR/trailing, qty, webhook).
   * Click **Apply** → server validates → UI shows “Applied.” and updates `version`.
3. **Start/Stop**:

   * **START STRATEGY** → calls `/api/strategy/start` with `{ accountId }`.
   * **STOP STRATEGY** → calls `/api/strategy/stop`.
   * Status pill switches between **RUNNING/STOPPED**.
4. **TRADE MONITOR** tab (optional now): click **Refresh** to call `/api/trades?limit=200`.

## 5) Quick checks

* Health: `GET http://localhost:4001/api/health` should be `OK`.
* Status: `GET http://localhost:4001/api/strategy/status` returns `{ "running": false|true }`.
* Config: `GET http://localhost:4001/api/strategy/config` returns `{ version, effective:{…} }`.
* Apply: `PUT http://localhost:4001/api/strategy/config` with only the 16 keys (+ `breakoutLookbackBars`) updates live without restarting.

## 6) Common gotchas

* **CORS error**: ensure UI is on `http://localhost:4000` and API CORS allows that origin.
* **412 on Apply**: server says version mismatch → UI auto-refreshes config; re-apply.
* **Accounts empty**: verify your `getAccounts()` returns tradeable accounts and the API forwards them unmodified.

That’s it. Open the page, select the account, adjust configs, Apply, then Start.
