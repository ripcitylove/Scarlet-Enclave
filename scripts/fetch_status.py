#!/usr/bin/env python3
"""Fetch live FAA airport status + news headlines and write app/data/status.json.

Stdlib only so it runs on a bare GitHub Actions runner. Every source is
optional: if one fails, the others still publish and the error is recorded.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

FAA_URL = "https://nasstatus.faa.gov/api/airport-status-information"
NEWS_QUERIES = [
    "FAA ground stop",
    "air traffic control communications outage",
    "flights grounded FAA outage",
]
UA = "Mozilla/5.0 (compatible; FlightStatusBot/1.0)"
OUT = os.path.join(os.path.dirname(__file__), "..", "app", "data", "status.json")


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def text(el, *names):
    for n in names:
        found = el.find(".//" + n)
        if found is not None and (found.text or "").strip():
            return found.text.strip()
    return ""


def parse_faa(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = {"updated": text(root, "Update_Time"), "ground_stops": [],
           "ground_delays": [], "delays": [], "closures": [], "other": []}
    for dt in root.iter("Delay_type"):
        name = text(dt, "Name")
        for prog in dt.iter("Program"):  # Ground stops
            out["ground_stops"].append({
                "airport": text(prog, "ARPT"), "reason": text(prog, "Reason"),
                "until": text(prog, "End_Time")})
        for gd in dt.iter("Ground_Delay"):
            out["ground_delays"].append({
                "airport": text(gd, "ARPT"), "reason": text(gd, "Reason"),
                "avg": text(gd, "Avg"), "max": text(gd, "Max")})
        for d in dt.iter("Delay"):
            kinds = []
            for ad in d.iter("Arrival_Departure"):
                kinds.append({"type": ad.get("Type", ""), "min": text(ad, "Min"),
                              "max": text(ad, "Max"), "trend": text(ad, "Trend")})
            out["delays"].append({"airport": text(d, "ARPT"),
                                  "reason": text(d, "Reason"), "detail": kinds})
        for a in dt.iter("Airport"):
            out["closures"].append({
                "airport": text(a, "ARPT"), "reason": text(a, "Reason"),
                "start": text(a, "Start"), "reopen": text(a, "Reopen")})
        if name and name not in ("Ground Stop Programs", "Ground Delay Programs",
                                 "General Arrival/Departure Delay Info",
                                 "Airport Closures"):
            out["other"].append(name)
    return out


def parse_rss(xml_bytes):
    root = ET.fromstring(xml_bytes)
    items = []
    for it in root.iter("item"):
        title = text(it, "title")
        src_el = it.find("source")
        source = (src_el.text or "").strip() if src_el is not None else ""
        if source and title.endswith(" - " + source):
            title = title[: -len(" - " + source)]
        try:
            ts = parsedate_to_datetime(text(it, "pubDate")).astimezone(timezone.utc).isoformat()
        except Exception:
            ts = ""
        items.append({"title": title, "url": text(it, "link"), "source": source, "time": ts})
    return items


def fetch_news():
    seen, items, errors = set(), [], []
    for q in NEWS_QUERIES:
        url = ("https://news.google.com/rss/search?q=" + urllib.parse.quote(q + " when:2d")
               + "&hl=en-US&gl=US&ceid=US:en")
        try:
            for i in parse_rss(get(url)):
                key = re.sub(r"\W+", "", i["title"].lower())[:80]
                if key and key not in seen:
                    seen.add(key)
                    items.append(i)
        except Exception as e:  # noqa: BLE001
            errors.append(f"news '{q}': {e}")
    items.sort(key=lambda i: i["time"], reverse=True)
    return items[:40], errors


def assess(faa):
    """Turn raw FAA data into a headline level for the banner."""
    if not faa:
        return {"level": "unknown", "headline": "FAA status unavailable"}
    gs = faa["ground_stops"]
    blob = " ".join(g["reason"] + " " + g["airport"] for g in gs).lower()
    if len(gs) >= 15 or re.search(r"\b(all|nationwide|national|zzz|nas)\b", blob):
        return {"level": "critical", "headline": f"Widespread ground stop ({len(gs)} programs)"}
    if gs:
        return {"level": "severe", "headline": f"Ground stops at {len(gs)} airport(s)"}
    if faa["ground_delays"] or faa["closures"]:
        n = len(faa["ground_delays"]) + len(faa["closures"])
        return {"level": "elevated", "headline": f"{n} ground delay program(s)/closure(s)"}
    if faa["delays"]:
        return {"level": "minor", "headline": f"Delays reported at {len(faa['delays'])} airport(s)"}
    return {"level": "normal", "headline": "No FAA-reported ground stops or delays"}


def main():
    errors, faa = [], None
    try:
        faa = parse_faa(get(FAA_URL))
    except Exception as e:  # noqa: BLE001
        errors.append(f"faa: {e}")
    news, nerr = fetch_news()
    errors += nerr
    data = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "assessment": assess(faa), "faa": faa, "news": news, "errors": errors}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, indent=1)
    print(json.dumps(data["assessment"]), "news:", len(news), "errors:", errors)
    return 0 if (faa or news) else 1


if __name__ == "__main__":
    sys.exit(main())
