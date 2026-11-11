#!/usr/bin/env python3
"""Daily share prices for Family Funds -> data/prices.json.

Downloads the exchange "bhavcopy" (end-of-day prices) in the UDiFF format:
  NSE  https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip
  BSE  https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_YYYYMMDD_F_0000.CSV
Columns used: ISIN, TckrSymb (symbol), SctySrs (series), FinInstrmNm (name), ClsPric (close).

NSE is the source. BSE fills in shares NSE doesn't list (same day), and is used on its own if NSE
can't be reached. Weekends and holidays have no file, so it walks back day by day.
Only company shares are kept: ISIN "INE....01...." in the equity series. ETFs, bonds, REITs etc.
are skipped unless their ISIN is listed in data/include-isins.txt.

On any failure the existing file is left as it is (exit code 1), so the app just shows an older date.
Standard library only.
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

NSE_URL = 'https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{d}_F_0000.csv.zip'
BSE_URL = 'https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{d}_F_0000.CSV'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    'Accept': 'text/csv,application/zip,application/octet-stream,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}
NEEDED = {'ISIN', 'TckrSymb', 'SctySrs', 'FinInstrmNm', 'ClsPric'}
EQUITY_ISIN = re.compile(r'^INE[A-Z0-9]{4}01[A-Z0-9]{3}$')  # company equity shares
NSE_SERIES = ['EQ', 'BE', 'BZ', 'SM', 'ST']                   # in order of preference
MIN_NSE, MIN_BSE = 1000, 1000                                   # a real file has thousands of shares


class NotPublished(Exception):
    """No file for that day (weekend, holiday, or not out yet)."""


def ist_today():
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=5, minutes=30)).date()


def get(url, referer):
    """GET with browser-like headers; retries on network errors. Raises NotPublished on 404."""
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={**HEADERS, 'Referer': referer})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise NotPublished(url)
            last = e
        except Exception as e:  # timeouts, resets
            last = e
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f'{url}: {last}')


def read_rows(text, where):
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows or not NEEDED <= set(rows[0]):
        # BSE answers a missing day with an ordinary web page instead of a 404.
        if text.lstrip()[:1] == '<':
            raise NotPublished(where)
        raise RuntimeError(f'{where}: unexpected columns {list(rows[0]) if rows else "(empty)"}')
    return rows


def nse_rows(day):
    data = get(NSE_URL.format(d=day.strftime('%Y%m%d')), 'https://www.nseindia.com/')
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise NotPublished(f'NSE {day}: not a zip')
    name = next(n for n in z.namelist() if n.lower().endswith('.csv'))
    return read_rows(z.read(name).decode('utf-8-sig'), f'NSE {day}')


def bse_rows(day):
    data = get(BSE_URL.format(d=day.strftime('%Y%m%d')), 'https://www.bseindia.com/')
    return read_rows(data.decode('utf-8-sig', errors='replace'), f'BSE {day}')


def close_of(row):
    try:
        v = float(row['ClsPric'])
    except (TypeError, ValueError):
        return None
    return round(v, 2) if v > 0 else None


def pick(rows, include, series_rank=None):
    """ISIN -> [close, symbol, name] for company shares (and any ISIN in the include list)."""
    out, rank = {}, {}
    for r in rows:
        isin = (r.get('ISIN') or '').strip()
        close = close_of(r)
        if not close:
            continue
        if isin in include:
            r_rank = -1
        elif EQUITY_ISIN.match(isin) and (series_rank is None or r['SctySrs'] in series_rank):
            r_rank = series_rank.index(r['SctySrs']) if series_rank else 0
        else:
            continue
        if isin in out and rank[isin] <= r_rank:
            continue
        out[isin] = [close, r['TckrSymb'].strip(), ' '.join(r['FinInstrmNm'].split())]
        rank[isin] = r_rank
    return out


def read_include(path):
    if not os.path.exists(path):
        return set()
    with open(path, encoding='utf-8') as f:
        return {l.split('#')[0].strip().upper() for l in f if l.split('#')[0].strip()}


def find(fetch, start, days, label):
    """Walk back from start until a file exists. Returns (day, rows) or (None, reason)."""
    errors = []
    for i in range(days):
        day = start - dt.timedelta(days=i)
        if day.weekday() >= 5:
            continue
        try:
            return day, fetch(day)
        except NotPublished:
            print(f'  {label} {day}: no file')
        except Exception as e:
            print(f'  {label} {day}: failed: {e}')
            errors.append(str(e))
            if len(errors) >= 3:  # blocked or down, not just a holiday
                break
    return None, '; '.join(errors) or f'no {label} file in the last {days} days'


def build(start, days, include):
    print(f'Looking for prices on or before {start} (IST)')
    day, rows = find(nse_rows, start, days, 'NSE')
    if day:
        prices = pick(rows, include, NSE_SERIES)
        if len(prices) < MIN_NSE:
            raise RuntimeError(f'NSE {day}: only {len(prices)} shares, expected thousands')
        source, filled = 'NSE', 0
        try:
            extra = pick(bse_rows(day), include)
            for isin, v in extra.items():
                if isin not in prices:
                    prices[isin] = v + ['B']
                    filled += 1
        except Exception as e:
            print(f'  BSE {day} (to fill BSE-only shares): {e}')
        print(f'NSE {day}: {len(prices) - filled} shares; BSE added {filled} not listed on NSE')
    else:
        print(f'NSE unavailable ({rows}); trying BSE')
        day, rows = find(bse_rows, start, days, 'BSE')
        if not day:
            raise RuntimeError(f'No prices from NSE or BSE: {rows}')
        prices = {k: v + ['B'] for k, v in pick(rows, include).items()}
        if len(prices) < MIN_BSE:
            raise RuntimeError(f'BSE {day}: only {len(prices)} shares, expected thousands')
        source = 'BSE'
        print(f'BSE {day}: {len(prices)} shares')
    return {
        'date': day.isoformat(),
        'source': source,
        'note': 'p: ISIN -> [close, symbol, name] (4th item "B": BSE price, not listed on NSE)',
        'count': len(prices),
        'p': dict(sorted(prices.items())),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', default='data/prices.json')
    ap.add_argument('--include', default='data/include-isins.txt')
    ap.add_argument('--date', help='latest day to look for (YYYY-MM-DD, default today IST)')
    ap.add_argument('--days', type=int, default=10, help='how many days to walk back')
    ap.add_argument('--dry-run', action='store_true', help='download and check, but write nothing')
    a = ap.parse_args()
    start = dt.date.fromisoformat(a.date) if a.date else ist_today()
    try:
        result = build(start, a.days, read_include(a.include))
    except Exception as e:
        print(f'FAILED: {e}\nExisting {a.out} left unchanged.')
        summary(f'### Share prices: failed\n{e}\n\nThe existing prices file was left unchanged.')
        return 1

    old = None
    if os.path.exists(a.out):
        with open(a.out, encoding='utf-8') as f:
            try:
                old = json.load(f)
            except ValueError:
                old = None
    if old and old.get('date', '') > result['date']:
        print(f'Existing file is newer ({old["date"]}); keeping it.')
        return 0
    sample = {k: result['p'][k] for k in ('INE002A01018', 'INE009A01021', 'INE040A01034') if k in result['p']}
    text = json.dumps(result, separators=(',', ':'), ensure_ascii=False) + '\n'
    report = (f"### Share prices for {result['date']} ({result['source']})\n"
              f"{result['count']} shares, {len(text) // 1024} KB. Sample: `{json.dumps(sample)}`")
    if a.dry_run:
        print('Dry run, nothing written.\n' + report)
        summary(report + '\n\nDry run: nothing was written.')
        return 0
    if old == result:
        print('No change.')
        summary(report + '\n\nNo change since the last run.')
        return 0
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, a.out)
    print('Wrote ' + a.out + '\n' + report)
    summary(report)
    return 0


def summary(md):
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a', encoding='utf-8') as f:
            f.write(md + '\n')


if __name__ == '__main__':
    sys.exit(main())
