# Family Funds

A private mutual fund and share tracker for one family. Members have portfolios; portfolios hold
mutual fund folios (with their scheme holdings and transactions) and shares (from demat accounts).
Dashboards show invested, current value, XIRR, gain/loss, breakups and combined holdings at every
level, with an **All · Mutual funds · Shares** switch.

Live app: GitHub Pages (`https://<user>.github.io/family-funds/`)

## How it fits together

- **No build step.** Plain HTML/CSS/ES modules. GitHub Pages serves the repo as-is.
- **Firebase** (project `family-funds-e2607`, Firestore in asia-south1):
  - Google sign-in (Firebase Auth, popup).
  - Firestore collections: `members`, `portfolios`, `folios`, `holdings`, `schemes`, `demats`, `shares`, `users`.
  - Access is enforced by `firestore.rules` (paste into Firebase console → Firestore → Rules).
    The owner email is hard-coded there and in `js/config.js`; other people are listed in `users/{email}`
    with role `viewer` | `editor` | `admin`.
- **NAVs and scheme data** come from mfapi.in (AMFI data) in the browser: search, latest NAV,
  NAV history (used to estimate units when left blank). Until a scheme has today's NAV (AMFI
  publishes in the evening, IST) the app re-checks it at most every 3 hours: on load, when the
  tab comes back into view, and every hour while open. Whoever has the app open does it.
- **Gains and sales:** Invested is the FIFO cost of the units still held, so Gain / loss is current
  value minus that cost; selling units reduces both. A folio whose units are all sold moves to
  **Closed folios** (sidebar), which shows what was bought and sold, the realised gain and XIRR.
  It keeps its portfolio, so buying again brings it back. XIRR, like Gain / loss, covers only the
  units still held: each remaining lot's cost on its purchase date against today's value. Sold
  units, sales and IDCW payouts are left out (the Closed folios page shows their realised XIRR).
- **CAS import** (“Import CAS” button): editors upload a CAMS/KFintech *detailed* CAS PDF. It's opened
  in the browser with pdf.js (loaded from jsDelivr on demand, password supported) and never uploaded.
  Schemes are matched by ISIN to mfapi.in codes. Folios are matched by folio number, and
  transactions already stored (same date, units and amount) are skipped, so re-importing a newer
  statement only adds what's new. Stamp duty is added to its purchase and STT/TDS taken off the
  redemption. The review step warns when a statement starts part-way through a holding (opening
  units with no cost) or when the units don't add up to the closing balance.
  **Statement check:** for every scheme in the statement, the review compares what the tracker holds
  (after the import) with the statement's closing units and Total Cost Value, and flags any that
  differ. Re-uploading a recent statement is a way to check folios already imported.

### Shares

- **Prices:** a GitHub Action (`.github/workflows/share-prices.yml`, weekdays 19:07 and 21:37 IST,
  or run by hand) downloads NSE's end-of-day "bhavcopy" (UDiFF format) and saves `data/prices.json`:
  `p: { ISIN: [close, symbol, name] }` plus the price `date` and `source`. BSE's bhavcopy fills in
  shares NSE doesn't list (marked `"B"`), and is used on its own if NSE fails. Weekends and holidays
  have no file, so it walks back day by day. Only company shares are kept (ISIN `INE….01…`, equity
  series); add other ISINs (an ETF, a REIT) to `data/include-isins.txt`. On failure nothing is
  written, so the app just shows an older "Share prices as of" date. The file doubles as the search
  list for "+ Add share". No keys, no paid APIs, no live prices.
- **Sector and market cap:** `.github/workflows/stock-meta.yml` (3rd of each month, on demand, and
  whenever a file is uploaded to `data/amfi/`) saves `data/stock-meta.json`:
  `m: { ISIN: [L|M|S, sector, name] }`. Sector comes from NSE's Nifty 500 list ("Industry"), so
  smaller companies show "Other" unless you set one. Large / Mid / Small come from AMFI's
  half-yearly market-cap list. If a source fails, its previous data is kept.
- **The app** loads both files from this site on start, when the tab comes back into view, and
  hourly; it shows "Share prices as of <date>" in the sidebar.
- **Demat accounts and shares** live in Firestore (`demats`, `shares`). A share sits in a portfolio
  of its own choosing (not per demat account) and can be moved like a folio.
- **Axis Direct import** ("Import CAS" → Shares · Axis Direct), the main route for shares: the
  **Portfolio Holding Statement** (ISIN, quantity and Axis's average cost on a date) and, optionally,
  the **PAN Level Transaction Report** (trades and dividends). Both are password-protected Excel
  files (password: the PAN in capitals); `js/xlsx.js` unlocks and reads them in the browser with no
  libraries (Excel "Standard" encryption: SHA-1 key, AES-128) and nothing is uploaded. `js/axis.js`
  takes the holding statement as the starting point (each share at Axis's average cost), adds
  trades dated after it, and merges dividends. Trade-report names are matched to ISINs via the
  holding statement, then the price file. A share gets a first-bought date only when the trade
  report explains its whole holding (so run both reports from the account's opening date);
  bonuses, splits, mergers, demergers and buybacks in the report are counted for this, and the date
  is the start of the current holding (after the last time it went to zero). The review only shows
  a message when something needs attention. The
  account is remembered by its Axis client ID; re-importing the same files changes nothing, and a
  newer pair updates quantities and averages (keeping any first-bought date you entered).
- **NSDL / CDSL CAS import** ("Import CAS" → Shares · NSDL / CDSL), for other brokers or to check
  quantities: if a statement account is the Axis account already tracked, choose it under
  "Already in the tracker as" so its shares aren't added twice.
- **NSDL / CDSL details:** the statement PDF is read in the browser
  (`js/cas-demat.js`; password usually the PAN in capitals) and never uploaded. Demat accounts are
  matched by DP ID + client ID, shares by ISIN. The review shows each share as New, No change, or a
  quantity change (`60 → 75 (+15)`); an increase is "Bought more" (optional price) or "Bonus /
  split" (no cost); a decrease is a sale at average cost; a tracked share missing from the
  statement can be marked "sold all". Re-importing the same statement changes nothing. Mutual fund
  sections and other securities are listed as skipped.
- **Maths** (`js/calc.js`): quantity = sum of transactions; invested = average cost of the shares
  held (a sale removes the same fraction of every lot; a bonus or split adds shares at no cost);
  gain = current value − invested. A share without a buy price counts in current value only, not
  in invested, gain or XIRR. XIRR uses each held lot's cost on its date plus dividends; shares held
  under a year show "< 1 yr", and lots without a date show "—". The All view merges fund and share
  cash flows, valued on the later of the NAV date and the price date. Fully sold shares count
  nowhere and are listed on the Closed page.
- **Buy prices:** depository statements don't show what you paid, so enter the average buy price
  from your broker app ("Add buy price"). That records the current quantity at that average. The
  model stores transactions, so a broker tradebook import can be added later.

## Files

| File | Purpose |
|---|---|
| `index.html` | Shell; loads `js/main.js` |
| `js/main.js` | Firebase init, sign-in gate, role check, starts the app |
| `js/config.js` | Firebase web config + owner email (not secret) |
| `js/firebase-store.js` | Firestore-backed store (live sync, writes, NAV refresh) |
| `js/app.js` | All UI: views, dialogs, drag-and-drop, access page |
| `js/calc.js` | FIFO cost basis, XIRR, aggregation, breakups |
| `js/mf.js` | mfapi.in client + AMFI category → asset class mapping + ISIN lookup |
| `js/cas.js` | CAS PDF reader (pdf.js) and parser → folios, schemes, transactions |
| `js/cas-demat.js` | NSDL / CDSL CAS parser → demat accounts and shares; import matching |
| `js/xlsx.js` | Reads .xlsx files in the browser, including password-protected ones |
| `js/axis.js` | Axis Direct holding statement + transaction report → shares; import matching |
| `js/prices.js` | Loads `data/prices.json` and `data/stock-meta.json` from the site |
| `scripts/share_prices.py`, `scripts/stock_meta.py` | The two GitHub Action jobs (standard-library Python) |
| `.github/workflows/` | `share-prices.yml` (daily), `stock-meta.yml` (monthly / on upload) |
| `data/` | `prices.json`, `stock-meta.json` (written by the jobs), `include-isins.txt`, `amfi/` (manual AMFI uploads) |
| `tests/` | `node --test tests/*.test.mjs`: share maths, statement and Axis import matching |
| `js/format.js` | Indian number/date formatting |
| `js/data.js`, `js/preview-main.js` | Sample-data store for the offline preview |
| `build-preview.mjs` | `node build-preview.mjs` → single-file `preview.html` with sample data |
| `firestore.rules` | Security rules (source of truth; deploy by pasting in the console) |

## Data model

```
members/{id}     { name, order }
portfolios/{id}  { memberId, name, order }
folios/{id}      { folioNo, amc, holder, portfolioId|null, order }   // holder shown = the portfolio's member; saved on move, kept when unassigned
holdings/{id}    { folioId, schemeCode, txns: [{ date: 'YYYY-MM-DD', amount, units }] }   // redemptions: negative amount & units
schemes/{code}   { code, name, amc, assetClass, category, amfiCategory, isin, nav, navDate, checkedOn }
demats/{id}      { broker, dpId, clientId, brokerClientId|null, holderName, memberId|null, order }   // Axis accounts: brokerClientId
shares/{id}      { isin, name, dematId, portfolioId|null, order, sectorOverride|null,   // name: as in the import, if the price file lacks it
                   txns: [{ date|null, qty, price|null, kind }],   // kind: buy | sell | bonus | split | opening; sells: negative qty
                   dividends: [{ date, amount }] }
users/{email}    { role, updatedAt }
```

## Making changes

1. Edit files; check the UI with `node build-preview.mjs` and open `preview.html`; run the tests
   with `node --test tests/*.test.mjs`.
2. Commit and push to `main`; GitHub Pages redeploys in about a minute.
3. If you change `firestore.rules`, paste the new rules into the Firebase console and publish.

## Publish the new Firestore rules

Needed once, for shares. Until then the app works as before but can't save or show shares, and
editors see a banner saying so.

1. Open https://console.firebase.google.com and sign in with the owner Google account.
2. Click the project **family-funds-e2607**.
3. In the left menu click **Build → Firestore Database** (or just **Firestore Database**).
4. Click the **Rules** tab at the top.
5. Click inside the rules editor, select everything (Ctrl+A, or Cmd+A on a Mac) and delete it.
6. Open `firestore.rules` in this repository on GitHub, click the **Copy raw file** button
   (two overlapping squares, top right of the file), and paste into the empty editor.
7. Click **Publish**. You should see "Rules published" or the publish time update.
8. Check: the line starting `allow read: if col in [` now ends with `'demats', 'shares'] && canRead();`.
   Reload the app: the red "rules need updating" banner is gone.

## Share price job: running it and checking it worked

- **Run it by hand:** on GitHub open the repository → **Actions** tab → **Share prices** (left
  list) → **Run workflow** (right) → **Run workflow**. Refresh after a minute.
- **Did it run, and succeed?** **Actions** tab → **Share prices**. Each run is listed with a green
  tick (worked) or red cross (failed). Click a run → **prices** to see the log, and scroll to the
  summary: "Share prices for <date> (NSE) … N shares". "No change" means the day's file wasn't out
  yet (the 21:37 retry picks it up) or nothing changed.
- **In the app:** the sidebar shows "Share prices as of <date>", normally the last trading day.
- If GitHub ever pauses the schedule (it does after 60 days without activity in the repository),
  the **Actions** tab shows a banner with an **Enable workflow** button.

## Refreshing market-cap data (twice a year)

AMFI publishes its market-cap list in early **January** (six months to 31 December) and early
**July** (six months to 30 June). The monthly job tries AMFI's usual address, so usually there's
nothing to do. If, by mid-February or mid-August, the app still lists shares by the old half-year:

1. Check which list is in use: open `data/stock-meta.json` on GitHub; near the start it says
   `"capPeriod":"YYYY-MM-DD"`, the end of the half-year it covers.
2. Get the new list: open https://www.amfiindia.com, search the site for **"Categorization of
   stocks"** or **"Average Market Capitalization"**, and download the newest Excel file (`.xlsx`).
3. On GitHub, open the repository, click into the **data** folder, then the **amfi** folder.
4. Click **Add file → Upload files**, drag the `.xlsx` file in, and click **Commit changes**.
5. That starts the **Stock sectors and market cap** job automatically. After a minute or two, open
   the **Actions** tab → **Stock sectors and market cap**: the newest run should have a green tick
   and its summary should say "Market cap: … six months to <new date>".
6. If it says "kept previous list", the file wasn't newer or wasn't AMFI's list; check you
   downloaded the right file.

## Getting your NSDL / CDSL statement (forward this to family members)

The share import needs your **Consolidated Account Statement (CAS)** from NSDL or CDSL, the two
depositories that hold demat accounts. It lists every demat account under your PAN.

**Easiest:** NSDL or CDSL already emails it to you every month you trade (otherwise every six
months). In your email, search for **"Consolidated Account Statement"** from NSDL or CDSL and
download the attached PDF.

**To get one now:**
- *Which depository?* In your broker app's profile, look at your demat details. A DP ID starting
  with **IN** (like IN303028) is **NSDL**; a 16-digit number with no letters (a "BO ID") is
  **CDSL**. Zerodha, Groww, Upstox and Angel One accounts are usually CDSL.
- *CDSL:* go to https://www.cdslindia.com/CAS/LoginCAS.aspx, enter your **PAN Card No**, **BO ID**
  (the 16-digit demat number) and **Date of Birth**, and follow the steps to view and download your
  CAS.
- *NSDL:* go to https://nsdlcas.nsdl.com (NSDL eCAS) and follow the steps to request your CAS with
  your PAN; it's emailed to your registered email address.
- Either way you get one statement covering your accounts at both depositories.

**Password:** usually your **PAN in capital letters** (e.g. ABCDE1234F). The email says if it's
different.

**Import it:** open Family Funds → **Import CAS** → choose **Shares (NSDL / CDSL)** → choose the PDF
→ enter the password → **Read statement**. Check the review (the first time, pick whose demat
account it is and optionally an average buy price for each share), then click **Import**. Nothing
is uploaded: the PDF is read in your browser. Do the same with each new statement; shares that
haven't changed are left alone.

## Getting your Axis Direct reports (forward this to family members)

The share import reads two Excel files from Axis Direct: the holding statement as of **today**, and
the transaction report **from the day the account was opened up to today**. (Starting from the
opening date lets the app work out when each share was first bought, which XIRR needs.)

1. Open the Axis Direct app (or website) and log in.
2. Open the left menu → **Reports** → **My Reports** → **Holding Statement**, and download it
   dated today, as Excel.
3. In **My Reports**, open **PAN Level Transaction Report** (Equity), set the dates from the day the
   account was opened (or 1 Jan 2015 if you're not sure) to today, and download it as Excel.
4. Both files are password-protected; the password is the **PAN in capital letters**.
5. In Family Funds: **Import CAS** → **Shares · Axis Direct** → choose the holding statement in the
   first box and the transaction report in the second → enter the password → **Read statement**.
6. The first time, choose **whose account this is** and which portfolio the shares go in ("Put all
   new shares in" sets them all at once), then **Import**.
7. Next time, download both again (holding statement dated today, transaction report from the same
   start date to today) and import them the same way:
   only the changes are applied.

Nothing is uploaded: the files are read in your browser.
