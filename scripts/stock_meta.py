#!/usr/bin/env python3
"""Share sector and market-cap data for Family Funds -> data/stock-meta.json.

Sector: NSE's Nifty Total Market list ("Industry" column: the Nifty 500 plus the Nifty Microcap 250),
falling back to the Nifty 500 list. Companies outside these get no sector (the app shows "Other",
and a sector can be set by hand on the share).
Name: the current name from NSE's list of listed companies (EQUITY_L), which follows renames,
mergers and demergers; then the index list's name; then AMFI's (only updated half-yearly).
Market cap (Large / Mid / Small): AMFI's half-yearly "Average Market Capitalization" list, which
categorises every listed company. AMFI publishes it in January (six months to 31 December) and July
(six months to 30 June). This script tries AMFI's usual download address for recent half-years, and
also reads any .xlsx file placed in data/amfi/ (upload one through the GitHub website if AMFI moves
the file). It uses whichever list is newest.

Each part is refreshed on its own: if one source fails, its previous data is kept. If both fail,
nothing is written (exit code 1). Standard library only.
"""
import argparse
import csv
import datetime as dt
import glob
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

EQUITY_URLS = [
    'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
    'https://archives.nseindia.com/content/equities/EQUITY_L.csv',
]
NIFTY500_URLS = [
    'https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv',
    'https://www.niftyindices.com/IndexConstituent/ind_niftytotalmarket_list.csv',
    'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv',
    'https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv',
    'https://archives.nseindia.com/content/indices/ind_nifty500list.csv',
]
AMFI_URL = 'https://www.amfiindia.com/Themes/Theme1/downloads/AverageMarketCapitalization{p}.xlsx'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    'Accept': 'text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}
CAP = {'large cap': 'L', 'mid cap': 'M', 'small cap': 'S'}
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']


def get(url):
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except Exception as e:
            last = e
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f'{url}: {last}')


# ---------- Nifty 500 sectors ----------
def nifty500():
    errors = []
    for url in NIFTY500_URLS:
        try:
            data = get(url)
            if not data:
                errors.append(f'{url}: not found')
                continue
            rows = list(csv.DictReader(io.StringIO(data.decode('utf-8-sig'))))
            if not rows or not {'ISIN Code', 'Industry'} <= set(rows[0]):
                errors.append(f'{url}: unexpected columns')
                continue
            sectors = {r['ISIN Code'].strip(): r['Industry'].strip() for r in rows if r['ISIN Code'].strip() and r['Industry'].strip()}
            if len(sectors) < 400:  # the Nifty 500 or more
                errors.append(f'{url}: only {len(sectors)} rows')
                continue
            names = {r['ISIN Code'].strip(): r['Company Name'].strip() for r in rows}
            return sectors, names, url
        except Exception as e:
            errors.append(str(e))
    raise RuntimeError('Nifty 500 list unavailable: ' + '; '.join(errors))


# ---------- current company names (NSE list of listed companies) ----------
def tidy(name):
    n = ' '.join(name.split())
    return re.sub(r'\bLimited$', 'Ltd', n, flags=re.I)


def equity_names():
    errors = []
    for url in EQUITY_URLS:
        try:
            data = get(url)
            if not data:
                errors.append(f'{url}: not found')
                continue
            rows = [{k.strip(): (v or '').strip() for k, v in r.items()} for r in csv.DictReader(io.StringIO(data.decode('utf-8-sig')))]
            names = {r['ISIN NUMBER']: tidy(r['NAME OF COMPANY']) for r in rows if r.get('ISIN NUMBER') and r.get('NAME OF COMPANY')}
            if len(names) < 1500:
                errors.append(f'{url}: only {len(names)} rows')
                continue
            return names, url
        except Exception as e:
            errors.append(str(e))
    raise RuntimeError('NSE company list unavailable: ' + '; '.join(errors))


# ---------- AMFI market cap (.xlsx read with the standard library) ----------
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def xlsx_rows(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(NS + 'si'):
            shared.append(''.join(t.text or '' for t in si.iter(NS + 't')))
    sheet = sorted(n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n))[0]
    for row in ET.fromstring(z.read(sheet)).iter(NS + 'row'):
        out = {}
        for c in row.findall(NS + 'c'):
            col = re.match(r'[A-Z]+', c.get('r')).group()
            v = c.find(NS + 'v')
            if c.get('t') == 's' and v is not None:
                out[col] = shared[int(v.text)]
            elif c.get('t') == 'inlineStr':
                out[col] = ''.join(t.text or '' for t in c.iter(NS + 't'))
            else:
                out[col] = v.text if v is not None else ''
        yield out


def amfi_list(data, where):
    """-> (period 'YYYY-MM-DD', {ISIN: 'L'|'M'|'S'}, {ISIN: name})"""
    rows = list(xlsx_rows(data))
    period = None
    for r in rows[:5]:
        m = re.search(r'ended\s+(\d{1,2})\s+([A-Za-z]+)\s*,?\s*(\d{4})', ' '.join(r.values()))
        if m and m.group(2).capitalize() in MONTHS:
            period = dt.date(int(m.group(3)), MONTHS.index(m.group(2).capitalize()) + 1, int(m.group(1))).isoformat()
            break
    head_i = next((i for i, r in enumerate(rows[:10]) if any(str(v).strip() == 'ISIN' for v in r.values())), None)
    if period is None or head_i is None:
        raise RuntimeError(f'{where}: not an AMFI market cap list (no period or ISIN column)')
    head = rows[head_i]
    col = lambda pred: next(k for k, v in head.items() if pred(str(v).strip().lower()))
    c_isin, c_cat = col(lambda v: v == 'isin'), col(lambda v: v.startswith('categori'))
    c_name = col(lambda v: v.startswith('company'))
    caps, names = {}, {}
    for r in rows[head_i + 1:]:
        isin = (r.get(c_isin) or '').strip()
        cap = CAP.get((r.get(c_cat) or '').strip().lower())
        if isin and cap:
            caps[isin] = cap
            names[isin] = ' '.join((r.get(c_name) or '').split())
    if len(caps) < 3000:
        raise RuntimeError(f'{where}: only {len(caps)} companies')
    return period, caps, names


def half_years(today, n=4):
    """Recent half-year ends, newest first: 30 Jun / 31 Dec."""
    out, y = [], today.year
    while len(out) < n:
        for d in (dt.date(y, 12, 31), dt.date(y, 6, 30)):
            if d < today and len(out) < n:
                out.append(d)
        y -= 1
    return out


def amfi(today, folder):
    found, notes = [], []
    for path in sorted(glob.glob(os.path.join(folder, '*.xlsx'))):
        try:
            with open(path, 'rb') as f:
                found.append(amfi_list(f.read(), path) + (path,))
        except Exception as e:
            notes.append(f'{path}: {e}')
    for d in half_years(today):
        url = AMFI_URL.format(p=f'{d.day}{d.strftime("%b")}{d.year}')
        try:
            data = get(url)
            if data and data[:2] == b'PK':
                found.append(amfi_list(data, url) + (url,))
                break  # newest online list found; older ones aren't needed
            notes.append(f'{url}: not found')
        except Exception as e:
            notes.append(f'{url}: {e}')
    if not found:
        raise RuntimeError('AMFI market cap list unavailable: ' + '; '.join(notes))
    return max(found, key=lambda x: x[0])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', default='data/stock-meta.json')
    ap.add_argument('--amfi-folder', default='data/amfi')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    today = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=5, minutes=30)).date()

    old = {}
    if os.path.exists(a.out):
        with open(a.out, encoding='utf-8') as f:
            try:
                old = json.load(f)
            except ValueError:
                old = {}
    old_m = old.get('m', {})
    sectors = {k: v[1] for k, v in old_m.items() if v[1]}
    caps = {k: v[0] for k, v in old_m.items() if v[0]}
    names = {k: v[2] for k, v in old_m.items() if v[2]}
    sector_src, cap_src = old.get('sectorSource'), old.get('capPeriod')
    ok, report = 0, []
    # Names, oldest source first so newer ones win: AMFI (half-yearly), index list (monthly),
    # NSE's list of listed companies (daily; follows renames, mergers and demergers).
    index_names, nse_names = {}, {}

    try:
        s, index_names, url = nifty500()
        sectors, sector_src, ok = s, ('Nifty Total Market list (NSE)' if 'totalmarket' in url else 'Nifty 500 list (NSE)'), ok + 1
        report.append(f'Sectors: {len(s)} companies from {url}')
    except Exception as e:
        report.append(f'Sectors: kept previous data ({e})')
    try:
        period, c, n, where = amfi(today, a.amfi_folder)
        if cap_src and period < cap_src:
            report.append(f'Market cap: kept previous list ({cap_src}); newest found is {period} ({where})')
        else:
            caps, cap_src, ok = c, period, ok + 1
            names.update(n)
            report.append(f'Market cap: {len(c)} companies, six months to {period}, from {where}')
    except Exception as e:
        report.append(f'Market cap: kept previous data ({e})')
    try:
        nse_names, url = equity_names()
        ok += 1
        report.append(f'Names: {len(nse_names)} listed companies from {url}')
    except Exception as e:
        report.append(f'Names: kept previous names ({e})')
    names.update({k: tidy(v) for k, v in index_names.items() if v})
    names.update(nse_names)

    for line in report:
        print(line)
    if not ok:
        print('FAILED: neither source could be read; existing file left unchanged.')
        summary('### Stock metadata: failed\n' + '\n'.join(f'- {l}' for l in report))
        return 1
    result = {
        'capPeriod': cap_src,
        'sectorSource': sector_src,
        'note': 'm: ISIN -> [market cap L|M|S or "", sector or "", name]',
        'm': {k: [caps.get(k, ''), sectors.get(k, ''), names.get(k, '')] for k in sorted(set(caps) | set(sectors) | set(nse_names))},
    }
    md = '### Stock metadata\n' + '\n'.join(f'- {l}' for l in report)
    if a.dry_run:
        print('Dry run, nothing written.')
        summary(md + '\n\nDry run: nothing was written.')
        return 0
    if result == old:
        print('No change.')
        summary(md + '\n\nNo change.')
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
