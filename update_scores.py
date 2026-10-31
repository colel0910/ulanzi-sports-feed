#!/usr/bin/env python3
"""Generate small ESPN sports score feeds for AWTRIX NG."""
import datetime as dt
import json
import pathlib
import urllib.request
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).parent / "docs"
SPORTS = {"nfl": ("football", "nfl"), "mlb": ("baseball", "mlb"), "nba": ("basketball", "nba"), "nhl": ("hockey", "nhl")}

def fetch(sport):
    category, league = SPORTS[sport]
    date = dt.datetime.now(ZoneInfo("America/New_York")).strftime("%Y%m%d")
    url = f"https://site.api.espn.com/apis/site/v2/sports/{category}/{league}/scoreboard?limit=100&dates={date}"
    req = urllib.request.Request(url, headers={"User-Agent": "UlanziSportsFeed/1.0"})
    with urllib.request.urlopen(req, timeout=18) as response:
        return json.load(response)

def parse_event(event, code):
    comps = event.get("competitions") or []
    if not comps:
        return None
    teams = comps[0].get("competitors") or []
    if len(teams) < 2:
        return None
    def abbr(t):
        return (t.get("team") or {}).get("abbreviation", "").upper()
    if code not in [abbr(t) for t in teams]:
        return None
    status = event.get("status") or {}
    state = (status.get("type") or {}).get("state") or "pre"
    away = next((t for t in teams if t.get("homeAway") == "away"), teams[0])
    home = next((t for t in teams if t.get("homeAway") == "home"), teams[1])
    return {
        "team1": abbr(away), "points1": str(away.get("score") if away.get("score") is not None else "0"),
        "team2": abbr(home), "points2": str(home.get("score") if home.get("score") is not None else "0"),
        "state": state,
        "score": " ".join(f'{abbr(t)} {t.get("score", "0")}' for t in teams)[:52],
        "period": str(status.get("period") or 0),
        "clock": str(status.get("displayClock") or "")[:10],
        "detail": str((status.get("type") or {}).get("shortDetail") or "")[:64],
        "date": event.get("date") or "",
    }

def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    updated = dt.datetime.now(dt.timezone.utc).isoformat()
    good = 0
    for sport in SPORTS:
        try:
            data = fetch(sport)
            team = "PHI"
            candidates = [parsed for event in data.get("events", []) if (parsed := parse_event(event, team))]
            chosen = next((g for g in candidates if g["state"] == "in"), None) or next((g for g in candidates if g["state"] == "post"), None) or (candidates[0] if candidates else None)
            doc = {
                "sport": sport, "team": team, "updated": updated,
                "updated_ms": int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000),
                "updated_s": int(dt.datetime.now(dt.timezone.utc).timestamp()),
                "team1": chosen["team1"] if chosen else "",
                "points1": chosen["points1"] if chosen else "",
                "team2": chosen["team2"] if chosen else "",
                "points2": chosen["points2"] if chosen else "",
                "state": chosen["state"] if chosen else "none",
                "score": chosen["score"] if chosen else "",
                "period": chosen["period"] if chosen else "",
                "clock": chosen["clock"] if chosen else "",
                "detail": chosen["detail"] if chosen else "",
                "next": chosen["date"] if chosen and chosen["state"] == "pre" else ""
            }
            (ROOT / f"{sport}-{team}.json").write_text(json.dumps(doc, separators=(",", ":")) + "\n")
            print(sport, team, doc["state"])
            good += 1
        except Exception as exc:
            print("ERROR", sport, exc)
    if not good:
        raise SystemExit("No sports feeds updated")

if __name__ == "__main__":
    main()
