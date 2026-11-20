#!/usr/bin/env python3
"""GIFT City (IFSC) fund NAVs and the US dollar rate for Family Funds -> data/global-funds.json.

GIFT City funds are priced in US dollars and aren't in AMFI's NAV data, so the app can't get them
from mfapi.in. This job saves, for every fund and share class on DSP's GIFT City site:
  - its NAV history in dollars (redemption NAV: what a unit is worth if sold that day), and
  - the dollar-to-rupee rate for each day (ECB reference rates, via Frankfurter),
so the app can value holdings in rupees. DSP's site doesn't let other web pages read its data
(no CORS), which is why this runs as a GitHub job instead of in the browser.

Sources (no keys):
  https://giftcity.dspim.com/api/v1/products                  funds, plans, share classes
  https://giftcity.dspim.com/api/v1/nav-history?schemeCode=…  NAV history of one share class
  https://api.frankfurter.dev/v1/<from>..<to>?from=USD&to=INR daily USD -> INR

Each part is refreshed on its own: if one source fails, its previous data is kept. If nothing could
be read, nothing is written (exit code 1). Standard library only.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DSP = 'https://giftcity.dspim.com/api/v1'
FX_URLS = ['https://api.frankfurter.dev/v1/{a}..{b}?from=USD&to=INR', 'https://api.frankfurter.app/{a}..{b}?from=USD&to=INR']
START = dt.date(2024, 1, 1)  # history kept from here (DSP's GIFT City retail funds launched after this)
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    'Accept': 'application/json',
}


def get_json(url):
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 404:
                break
        except Exception as e:
            last = e
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f'{url}: {last}')


def ist_today():
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=5, minutes=30)).date()


def dmy(s):
    """'17-Nov-2026' -> '2026-11-17'"""
    return dt.datetime.strptime(s, '%d-%b-%Y').date().isoformat()


def dsp_funds(today):
    """-> list of share classes with NAV history: [{code, name, amc, currency, assetClass, category, navs}]"""
    products = get_json(f'{DSP}/products')
    products = products.get('data', products) if isinstance(products, dict) else products
    out = []
    for f in products:
        outside = (f.get('scheme_type') or {}).get('code') != 'IND'
        for plan in f.get('plans') or []:
            for c in plan.get('share_class') or []:
                q = urllib.parse.urlencode({
                    'schemeCode': c['scheme_code'], 'schemePlan': plan['name'], 'schemeClass': c['code'],
                    'from': START.strftime('%d-%b-%Y'), 'to': today.strftime('%d-%b-%Y'),
                })
                hist = get_json(f'{DSP}/nav-history?{q}').get('navHistory') or []
                navs = sorted({dmy(h['date']): round(float(h['nav_redemption']), 4) for h in hist if h.get('nav_redemption')}.items())
                if not navs:
                    continue
                out.append({
                    'code': f"gift:{f['code']}-{c['code']}",
                    'name': f"{f['fund_name']} – Class {c['code']} ({plan['name']})",
                    'amc': 'DSP (GIFT City)',
                    'currency': f.get('currency') or 'USD',
                    'assetClass': 'Equity',
                    'category': 'Global' if outside else 'India via GIFT City',
                    'navs': [list(x) for x in navs],
                })
    if not out:
        raise RuntimeError('DSP returned no funds with NAVs')
    return out


def usd_inr(today):
    """-> [[date, rate], ...] since START (working days)."""
    errors = []
    for url in FX_URLS:
        try:
            d = get_json(url.format(a=START.isoformat(), b=today.isoformat()))
            rates = sorted((k, round(v['INR'], 4)) for k, v in d['rates'].items() if v.get('INR'))
            if len(rates) < 100:
                raise RuntimeError(f'only {len(rates)} days')
            return [list(x) for x in rates]
        except Exception as e:
            errors.append(f'{url}: {e}')
    raise RuntimeError('; '.join(errors))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', default='data/global-funds.json')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    today = ist_today()

    old = {}
    if os.path.exists(a.out):
        with open(a.out, encoding='utf-8') as f:
            try:
                old = json.load(f)
            except ValueError:
                old = {}
    funds, fx, ok, report = old.get('funds', []), old.get('usdInr', []), 0, []
    try:
        funds = dsp_funds(today)
        ok += 1
        report.append('DSP GIFT City: ' + '; '.join(f"{x['name']}: ${x['navs'][-1][1]} on {x['navs'][-1][0]}" for x in funds))
    except Exception as e:
        report.append(f'DSP GIFT City: kept previous data ({e})')
    try:
        fx = usd_inr(today)
        ok += 1
        report.append(f'USD → INR: {len(fx)} days, latest ₹{fx[-1][1]} on {fx[-1][0]}')
    except Exception as e:
        report.append(f'USD → INR: kept previous data ({e})')

    for line in report:
        print(line)
    if not ok:
        print('FAILED: no source could be read; existing file left unchanged.')
        summary('### GIFT City fund NAVs: failed\n' + '\n'.join(f'- {l}' for l in report))
        return 1
    result = {
        'note': 'funds: NAV history in the fund currency (redemption NAV), navs: [[date, nav]]; usdInr: [[date, rupees per dollar]] (ECB reference rate)',
        'funds': funds,
        'usdInr': fx,
    }
    md = '### GIFT City fund NAVs\n' + '\n'.join(f'- {l}' for l in report)
    if a.dry_run:
        print('Dry run, nothing written.')
        summary(md + '\n\nDry run: nothing was written.')
        return 0
    if result == old:
        print('No change.')
        summary(md + '\n\nNo change since the last run.')
        return 0
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(json.dumps(result, separators=(',', ':'), ensure_ascii=False) + '\n')
    os.replace(tmp, a.out)
    print('Wrote ' + a.out)
    summary(md)
    return 0


def summary(md):
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a', encoding='utf-8') as f:
            f.write(md + '\n')


if __name__ == '__main__':
    sys.exit(main())
