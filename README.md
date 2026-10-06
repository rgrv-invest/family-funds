# Family Funds

A private mutual fund tracker for one family. Members have portfolios; portfolios hold folios;
folios hold scheme holdings with their transactions. Dashboards show invested, current value,
XIRR, gain/loss, asset-class and category breakups, and combined holdings at every level.

Live app: GitHub Pages (`https://<user>.github.io/family-funds/`)

## How it fits together

- **No build step.** Plain HTML/CSS/ES modules. GitHub Pages serves the repo as-is.
- **Firebase** (project `family-funds-e2607`, Firestore in asia-south1):
  - Google sign-in (Firebase Auth, popup).
  - Firestore collections: `members`, `portfolios`, `folios`, `holdings`, `schemes`, `users`.
  - Access is enforced by `firestore.rules` (paste into Firebase console → Firestore → Rules).
    The owner email is hard-coded there and in `js/config.js`; other people are listed in `users/{email}`
    with role `viewer` | `editor` | `admin`.
- **NAVs and scheme data** come from mfapi.in (AMFI data) in the browser: search, latest NAV,
  NAV history (used to estimate units when left blank). NAVs refresh once a day per scheme,
  triggered by whoever opens the app first.
- **CAS import** (“Import CAS” button): editors upload a CAMS/KFintech *detailed* CAS PDF. It's opened
  in the browser with pdf.js (loaded from jsDelivr on demand, password supported) and never uploaded.
  Schemes are matched by ISIN to mfapi.in codes. Folios are matched by folio number, and
  transactions already stored (same date, units and amount) are skipped, so re-importing a newer
  statement only adds what's new. Stamp duty is added to its purchase and STT/TDS taken off the
  redemption. The review step warns when a statement starts part-way through a holding (opening
  units with no cost) or when the units don't add up to the closing balance.

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
| `js/format.js` | Indian number/date formatting |
| `js/data.js`, `js/preview-main.js` | Sample-data store for the offline preview |
| `build-preview.mjs` | `node build-preview.mjs` → single-file `preview.html` with sample data |
| `firestore.rules` | Security rules (source of truth; deploy by pasting in the console) |

## Data model

```
members/{id}     { name, order }
portfolios/{id}  { memberId, name, order }
folios/{id}      { folioNo, amc, holder, portfolioId|null, order }
holdings/{id}    { folioId, schemeCode, txns: [{ date: 'YYYY-MM-DD', amount, units }] }   // redemptions: negative amount & units
schemes/{code}   { code, name, amc, assetClass, category, amfiCategory, isin, nav, navDate, checkedOn }
users/{email}    { role, updatedAt }
```

## Making changes

1. Edit files; check the UI with `node build-preview.mjs` and open `preview.html`.
2. Commit and push to `main`; GitHub Pages redeploys in about a minute.
3. If you change `firestore.rules`, paste the new rules into the Firebase console and publish.
