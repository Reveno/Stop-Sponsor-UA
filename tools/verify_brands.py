#!/usr/bin/env python3
"""Refresh data/brands.json corporation entries from leave-russia.org (KSE
Institute's #LeaveRussia database), so status/threat claims are backed by a
citable, verifiable source instead of hand-written assertions.

Usage:
    python tools/verify_brands.py                   # fetch + write all known corporations
    python tools/verify_brands.py --dry-run          # fetch + print, don't write
    python tools/verify_brands.py --only pmi jti      # refresh a subset

    python tools/verify_brands.py --discover          # enumerate the FULL company
                                                        # list (thousands) into
                                                        # tools/kse_companies.json
    python tools/verify_brands.py --discover --max-pages 2   # bounded run for testing

`--discover` is the first step toward scaling past a hand-picked SLUG_MAP: it
walks leave-russia.org's three category listings (staying / leaving /
exited) via their internal AJAX pagination and records every company's
{slug, name, status} directly from the listing cards — no per-company page
fetch needed for that part, since the card already carries the status class
and the name is the logo's alt text. tools/brand_expander.py then reads
that file to go find sub-brands for whichever of those companies are
actually relevant to a shopping extension (there's no point enumerating
sub-brands for e.g. a shipping-logistics company no one will see on a
grocery site).

Only touches corporation keys listed in SLUG_MAP below in normal (non
--discover) mode. Add a new corp to brands.json's "corporations" object
first, then add its leave-russia.org slug here (find it by searching
https://leave-russia.org, or by running --discover and grepping the
output file).

No third-party dependencies (urllib + re only) so it runs anywhere without
`pip install`. Uses a real User-Agent and 1 req/sec rate limiting to stay a
polite, low-volume, robots.txt-compliant crawler (leave-russia.org/robots.txt
only disallows /admin and a handful of named SEO bots for a wildcard '*').
"""

import argparse
import html as html_module
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

# Company/brand names routinely contain non-ASCII characters; Windows
# consoles often default to a codepage that can't encode them.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parent.parent
BRANDS_JSON_PATH = REPO_ROOT / "data" / "brands.json"
KSE_COMPANIES_PATH = REPO_ROOT / "tools" / "kse_companies.json"
SOURCE_BASE = "https://leave-russia.org"
USER_AGENT = "spysok/1.0 (+https://github.com/YOUR_GITHUB_USERNAME/spysok)"
REQUEST_DELAY_SECONDS = 1.0

# The three top-level category listings that between them cover every
# company in the database (their homepage tallies of finer sub-statuses —
# Pausing Investments / Scaling Back / Suspension, etc. — nest under
# staying-companies and leaving-companies).
LISTING_PATHS = ["staying-companies", "leaving-companies", "companies-that-exited"]

# Listing cards look like:
#   <div data-link="//leave-russia.org/scania" class="card transfer exited">
#     ...<img src="..." alt="Scania">...
# — slug from data-link, status class from the first class after "card",
# name from the logo's alt text (may contain HTML entities, e.g. "L&#039;Occitane").
#
# Split on the card boundary first and search *within* each chunk, rather
# than one regex spanning from a data-link to the next alt="" with .*? —
# a card with no logo image has no alt="" of its own, so an unbounded
# non-greedy match would silently pair its slug with the *next* card's
# name. Splitting makes a missing alt simply not match, instead of
# cross-contaminating two companies.
CARD_HEAD_RE = re.compile(r'data-link="//leave-russia\.org/([a-z0-9\-]+)" class="card ([^"]+)"')
CARD_ALT_RE = re.compile(r'alt="([^"]*)"')

# corp key (as used in brands.json "corporations") -> leave-russia.org URL slug.
# Verified by hand against the live site; re-check if a fetch starts 404ing.
SLUG_MAP = {
    "pepsico": "pepsico",
    "mondelez": "mondelez",
    "nestle": "nestle",
    "pg": "procter-gamble",
    "unilever": "unilever",
    "mars": "mars",
    "xiaomi": "xiaomi",
    "haier": "haier",
    "pmi": "philip-morris",
    "jti": "japan-tobacco-international",
    "metro_ag": "metro-ag",
    "auchan": "auchan",
}

# NACP (National Agency on Corruption Prevention) "International Sponsors of
# War" list — a curated, sourced snapshot, NOT a live scrape. NACP's own
# sanctions.nazk.gov.ua subdomain (which hosted this list) no longer resolves
# at all (DNS NXDOMAIN as of 2026-08) — consistent with NACP's own published
# notice that the register was handed off to the Interdepartmental Working
# Group / State Sanctions Registry and the public list page was taken down on
# 2024-03-22 ("removed from public access following diplomatic pressure").
# There is no live NACP endpoint left to scrape. This dict is instead sourced
# from https://en.wikipedia.org/wiki/International_Sponsors_of_War (itself
# citing NACP/press coverage while the list was live), captured 2026-08 — a
# secondary source, dated, and clearly labeled as such in every generated
# description so nothing here is presented as more current or authoritative
# than it is. Keyed by normalized company name (see normalize_company_name).
NACP_WIKI_SOURCE_URL = "https://en.wikipedia.org/wiki/International_Sponsors_of_War"
NACP_PROPAGANDA_LIST = {
    "xiaomi": "2023", "xiaomi corporation": "2023",
    "mars": None, "mars inc": None,
    "mondelez": None, "mondelez international": None,
    "nestle": None,
    "pepsico": "2023",
    "philip morris international": None, "pmi": None,
    "procter gamble": None, "procter and gamble": None,
    "unilever": "2023",
    "auchan": "2022",
    "metro ag": None, "metro": None,
    "japan tobacco international": None, "jti": None,
    "leroy merlin": "2022",
    "alibaba": "2023", "alibaba group holding limited": "2023",
    "subway": "2024",
    "hikvision": None,
    "dahua technology": None, "dahua": None,
    "great wall motor": None,
    "zhejiang geely holding group": None, "geely": None,
    "sinopec": None, "china petrochemical corporation": None,
    "china national offshore oil corporation": None, "cnooc": None,
    "china national petroleum corporation": None, "cnpc": None,
    "knauf": None,
    "yves rocher": None,
    "barry callebaut": "2024",
    "bacardi": "2023",
    "dp world": "2023",
    "rockwool international": None, "rockwool": None,
    "slb": None, "schlumberger": None,
    "viciunai group": "2024",
    "sisecam group": None, "sisecam": None,
    "bonduelle": None,
    "danieli": "2022",
    "china state construction engineering corporation": None, "cscec": None,
    "china railway construction corporation": None,
    "fluxys": "2023",
    "buzzi unicem": "2022",
}


def normalize_company_name(name):
    n = name.lower()
    n = re.sub(r"[.,()&']", " ", n)
    n = re.sub(
        r"\b(inc|ltd|llc|plc|ag|corp|corporation|group|holding|holdings|international|company|co)\b",
        " ", n,
    )
    return re.sub(r"\s+", " ", n).strip()


def check_propaganda(name):
    """Returns (is_propaganda, date_added_or_None) by matching a normalized
    company name against NACP_PROPAGANDA_LIST. Substring match in both
    directions so "PepsiCo Inc" and "PepsiCo" both hit the "pepsico" key."""
    norm = normalize_company_name(name)
    if not norm:
        return False, None
    for key, date_added in NACP_PROPAGANDA_LIST.items():
        if key == norm or key in norm or norm in key:
            return True, date_added
    return False, None


def propaganda_description(name, date_added, lang):
    when_en = f" (added {date_added})" if date_added else ""
    when_ua = f" (додано {date_added})" if date_added else ""
    if lang == "en":
        return (
            f"Named on Ukraine's NACP \"International Sponsors of War\" list{when_en}, "
            f"identifying companies whose continued business in Russia is judged to "
            f"materially fund the war effort. NACP's own list page is no longer "
            f"publicly hosted (taken offline 2024-03-22); this is a dated snapshot "
            f"via {NACP_WIKI_SOURCE_URL}, not a live feed."
        )
    return (
        f"Внесено до переліку НАЗК «Міжнародні спонсори війни»{when_ua} — компанії, "
        f"чия діяльність у РФ визнана такою, що суттєво фінансує війну. Власна "
        f"сторінка переліку НАЗК більше не є публічно доступною (знята "
        f"22.03.2024); дані наведено за станом на дату фіксації через "
        f"{NACP_WIKI_SOURCE_URL}, це не пряма трансляція."
    )


# leave-russia.org status CSS class -> our brands.json status enum.
# Their taxonomy has finer gradations (see homepage tallies); we collapse to
# the four buckets content.js/i18n already support.
STATUS_CLASS_MAP = {
    "continue": "stay",
    "scalingback": "reduced",
    "suspension": "reduced",
    "withdrawal": "left",
    "transfer": "left",
}

# The site only server-renders an explanatory <strong>label</strong>: desc
# blurb for non-default statuses (class carries a "wd" = "with description"
# flag, e.g. scalingback/transfer). The common "continue" status renders
# without it — just a plain label inside the "vote" link — so the label
# extraction has two patterns and prefers the richer one when present.
STATUS_CLASS_RE = re.compile(r'<div class="cstatus top">\s*<div class="label status ([a-z]+)\s*(?:wd)?">')
STATUS_DSCR_RE = re.compile(r'<strong>([^<]+)</strong>:\s*(.*?)</p>', re.DOTALL)
STATUS_LABEL_FALLBACK_RE = re.compile(r'<span>Stay </span>([^<]+)</a>')


def fetch(slug):
    url = f"{SOURCE_BASE}/{slug}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    if "Page Not Found" in html.split("<body", 1)[-1][:500]:
        raise ValueError(f"{slug!r} -> 404 on {url}; slug may have changed")
    return url, html


def extract_stat(html, label):
    m = re.search(re.escape(f"<div>{label}</div><div>") + r"([\d.,]+)</div>", html)
    return m.group(1).replace(",", "") if m else None


def parse_company(slug, html):
    class_m = STATUS_CLASS_RE.search(html)
    if not class_m:
        raise ValueError(f"{slug!r}: couldn't find a status block — page layout may have changed")
    status_class = class_m.group(1).strip()

    # search from the status block onward so we don't pick up an unrelated
    # <strong>/<p> elsewhere on the page
    window = html[class_m.end():class_m.end() + 600]
    dscr_m = STATUS_DSCR_RE.search(window)
    if dscr_m:
        status_label, status_desc = dscr_m.groups()
        status_desc = re.sub(r"<[^>]+>", "", status_desc).strip()
    else:
        fallback_m = STATUS_LABEL_FALLBACK_RE.search(window)
        status_label = fallback_m.group(1).strip() if fallback_m else status_class
        status_desc = ""

    revenue_raw = extract_stat(html, "Revenue(RF), mln.USD")
    taxes_raw = extract_stat(html, "Taxes(RF), mln.USD")
    return {
        "status_class": status_class.strip(),
        "status_bucket": STATUS_CLASS_MAP.get(status_class.strip(), "unknown"),
        "status_label": status_label.strip(),
        "status_desc": status_desc,
        "revenue_rf_musd": revenue_raw,
        "taxes_rf_musd": taxes_raw,
        "revenue_rf_musd_num": float(revenue_raw) if revenue_raw else None,
        "taxes_rf_musd_num": float(taxes_raw) if taxes_raw else None,
    }


def derive_threat(parsed):
    if parsed["status_bucket"] == "left":
        return "none"
    if parsed["status_bucket"] == "reduced":
        return "medium"
    taxes = parsed["taxes_rf_musd"]
    if taxes is None:
        return "medium"
    taxes = float(taxes)
    if taxes >= 300:
        return "high"
    if taxes >= 50:
        return "medium"
    return "low"


def build_description(parsed, url, lang):
    revenue = parsed["revenue_rf_musd"]
    taxes = parsed["taxes_rf_musd"]

    if lang == "en":
        if parsed["status_bucket"] == "left":
            body = "Has exited the Russian market (KSE Leave-Russia status: 'Exit Completed')."
        elif parsed["status_bucket"] == "reduced":
            body = "Reducing some business operations in Russia while continuing others (KSE Leave-Russia status: 'Reducing Activities')."
        else:
            body = "Continues doing business in Russia as usual (KSE Leave-Russia status: 'Doing Business as Usual')."
        if revenue or taxes:
            figures = []
            if revenue:
                figures.append(f"${revenue}M in reported Russian revenue")
            if taxes:
                figures.append(f"${taxes}M in taxes paid to the Russian budget")
            body += " Reported " + " and ".join(figures) + "."
        body += f" Source: {url}"
        return body

    if lang == "uk":
        if parsed["status_bucket"] == "left":
            body = "Повністю залишила російський ринок (статус KSE Leave-Russia: 'Exit Completed')."
        elif parsed["status_bucket"] == "reduced":
            body = "Скорочує частину діяльності в РФ, продовжуючи іншу (статус KSE Leave-Russia: 'Reducing Activities')."
        else:
            body = "Продовжує вести бізнес у РФ у звичайному режимі (статус KSE Leave-Russia: 'Doing Business as Usual')."
        if revenue or taxes:
            figures = []
            if revenue:
                figures.append(f"виручка в РФ ${revenue} млн")
            if taxes:
                figures.append(f"сплачено податків до бюджету РФ ${taxes} млн")
            body += " За даними бази: " + ", ".join(figures) + "."
        body += f" Джерело: {url}"
        return body

    raise ValueError(lang)


def fetch_listing_page(path, page):
    url = f"{SOURCE_BASE}/{path}?event=ajax&action=ArticleList.displayCache.1079&page={page}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_listing_page(html):
    # bound each card's search window to [this card's data-link, next
    # card's data-link) so a missing/absent logo can't leak the next
    # card's name onto this one.
    heads = list(CARD_HEAD_RE.finditer(html))
    cards = []
    skipped_no_name = 0
    for i, head_m in enumerate(heads):
        window_end = heads[i + 1].start() if i + 1 < len(heads) else head_m.end() + 2000
        window = html[head_m.end():window_end]
        alt_m = CARD_ALT_RE.search(window)
        if not alt_m:
            skipped_no_name += 1
            continue
        slug, class_list = head_m.group(1), head_m.group(2)
        status_class = class_list.split()[0] if class_list.split() else ""
        cards.append({
            "slug": slug,
            "name": html_module.unescape(alt_m.group(1)).strip(),
            "status_class": status_class,
            "status_bucket": STATUS_CLASS_MAP.get(status_class, "unknown"),
        })
    if skipped_no_name:
        print(f"    ({skipped_no_name} card(s) had no logo alt text — skipped rather than risk misattributing a name)", file=sys.stderr)
    has_next = 'class="pager_button"' in html
    return cards, has_next


def discover_all(max_pages=None):
    companies = {}  # slug -> record, deduped across categories
    for path in LISTING_PATHS:
        page = 1
        while True:
            if companies or page > 1:
                time.sleep(REQUEST_DELAY_SECONDS)
            try:
                html = fetch_listing_page(path, page)
            except Exception as err:
                print(f"  SKIP {path} page {page}: {err}", file=sys.stderr)
                break

            cards, has_next = parse_listing_page(html)
            new_count = 0
            for card in cards:
                if card["slug"] not in companies:
                    new_count += 1
                companies[card["slug"]] = card
            print(f"  {path} page {page}: {len(cards)} cards ({new_count} new), total so far {len(companies)}")

            if not cards:
                break  # nothing parsed — layout may have changed, don't loop forever
            if max_pages and page >= max_pages:
                break
            if not has_next:
                break
            page += 1
    return companies


def run_discover(max_pages, dry_run):
    print(f"Discovering companies from {', '.join(LISTING_PATHS)}"
          + (f" (max {max_pages} pages/category)" if max_pages else " (full run)") + " ...")
    companies = discover_all(max_pages=max_pages)
    print(f"\nDiscovered {len(companies)} unique companies.")

    if dry_run:
        print("--dry-run: not writing kse_companies.json")
        return

    payload = {
        "fetchedAt": time.strftime("%Y-%m-%d"),
        "count": len(companies),
        "companies": companies,
    }
    with open(KSE_COMPANIES_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    print(f"Wrote {KSE_COMPANIES_PATH}")


def refresh(corp_keys, dry_run):
    with open(BRANDS_JSON_PATH, encoding="utf-8") as f:
        db = json.load(f)

    unknown_keys = [k for k in corp_keys if k not in SLUG_MAP]
    if unknown_keys:
        sys.exit(f"No leave-russia.org slug mapped for: {', '.join(unknown_keys)} — add to SLUG_MAP first.")

    for i, key in enumerate(corp_keys):
        slug = SLUG_MAP[key]
        if i > 0:
            time.sleep(REQUEST_DELAY_SECONDS)
        try:
            url, html = fetch(slug)
            parsed = parse_company(slug, html)
        except Exception as err:
            print(f"  SKIP {key} ({slug}): {err}", file=sys.stderr)
            continue

        if parsed["status_bucket"] == "unknown":
            print(f"  SKIP {key} ({slug}): status class {parsed['status_class']!r} doesn't map to "
                  f"stay/reduced/left — 'Verified Only' rule excludes unknown-status entries", file=sys.stderr)
            continue

        threat = derive_threat(parsed)
        entry = db["corporations"].setdefault(key, {})
        entry["status"] = parsed["status_bucket"]
        entry["threat"] = threat
        entry["inf_en"] = build_description(parsed, url, "en")
        entry["inf_ua"] = build_description(parsed, url, "uk")
        entry["source_url"] = url
        entry.setdefault("name", key)
        entry["revenue_rf_musd"] = parsed["revenue_rf_musd_num"]
        entry["taxes_rf_musd"] = parsed["taxes_rf_musd_num"]

        is_propaganda, date_added = check_propaganda(entry.get("name", key))
        if is_propaganda:
            entry["is_propaganda"] = True
            entry["propaganda_desc_en"] = propaganda_description(entry["name"], date_added, "en")
            entry["propaganda_desc_ua"] = propaganda_description(entry["name"], date_added, "uk")
        else:
            entry.pop("is_propaganda", None)
            entry.pop("propaganda_desc_en", None)
            entry.pop("propaganda_desc_ua", None)

        revenue_str = f"${parsed['revenue_rf_musd']}M" if parsed['revenue_rf_musd'] else "n/a"
        taxes_str = f"${parsed['taxes_rf_musd']}M" if parsed['taxes_rf_musd'] else "n/a"
        prop_flag = " [PROPAGANDA]" if is_propaganda else ""
        print(f"  {key:10s} -> status={parsed['status_bucket']:6s} threat={threat:6s} "
              f"revenue={revenue_str:8s} taxes={taxes_str:8s} ({url}){prop_flag}")

    db["updatedAt"] = time.strftime("%Y-%m-%d")

    if dry_run:
        print("\n--dry-run: not writing brands.json")
        return

    with open(BRANDS_JSON_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"\nWrote {BRANDS_JSON_PATH}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", nargs="+", metavar="CORP_KEY", help="only refresh these corporation keys")
    parser.add_argument("--dry-run", action="store_true", help="fetch/discover and print, don't write files")
    parser.add_argument("--discover", action="store_true",
                         help="enumerate the full company list into tools/kse_companies.json instead of refreshing brands.json")
    parser.add_argument("--max-pages", type=int, metavar="N",
                         help="--discover only: stop after N pages per category (each page is ~120 companies); omit for a full run")
    args = parser.parse_args()

    if args.discover:
        run_discover(args.max_pages, args.dry_run)
        return

    corp_keys = args.only if args.only else list(SLUG_MAP.keys())
    refresh(corp_keys, args.dry_run)


if __name__ == "__main__":
    main()
