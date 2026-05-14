"""
Load Japanese Singles 1on1 tournaments from the smash_database, time-sorted.

Unit of observation: Tournament (one event_dir). Each tournament has:
  - timestamp (the startAt from attr.json, shared by all matches in it)
  - standings: [(placement, user_id), ...] sorted by placement (ties allowed)
  - matches: list[Match] (possibly empty)
  - event_path (for logging)

Filters:
- region == "Japan"
- labels.game_rule == "1on1" (when available) OR event name heuristic
- num_entrants > 0
- match has non-null winner_id/loser_id
- match.state == 3 (completed)
- not DQ and not cancel
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator


@dataclass(frozen=True)
class Match:
    timestamp: int
    winner_id: int
    loser_id: int
    event_path: str


@dataclass
class Tournament:
    timestamp: int
    event_path: str
    # (placement, user_id). placement may repeat for ties.
    standings: list[tuple[int, int]]
    matches: list[Match]
    end_timestamp: int | None = None


_SINGLE_KEYWORDS = (
    "singles",
    "1on1",
    "1v1",
    "ultimate_singles",
    "シングル",
    "シングルス",
    "１on１",
    "1 on 1",
)
_EXCLUDE_KEYWORDS = (
    "doubles",
    "ダブルス",
    "crew",
    "クルー",
    "squad",
    "スクワッド",
    "team",
    "チーム",
    "2on2",
    "3on3",
    "4on4",
    "ダブル",
    "amateur",  # 初級者限定は別枠扱い (任意)
)

# Non-serious event signals (checked against event_name).
# Excluding: casual / character-restricted / beginner-only / item-on / online side brackets.
_NONSERIOUS_EVENT_KEYWORDS = (
    # casual
    "casual", "カジュアル", "交流",
    # character restriction
    "only", "限定", "縛り", "専用",
    # beginner-only
    "beginner", "初心者", "初級",
    # items / weird rules
    "item on", "アイテム", "変則",
    # online (sometimes only marked here, not in tournament name)
    "online", "オンライン",
    # joke / test
    "テスト", "検証", "test", "sample",
    # special formats (non-standard 1on1: squad queue mode, random-character modes)
    "ssqm", "ssdb",
    "random", "ランダム",
    "oma5", "おま5", "オマ5", "おまかせ",
)

# Same checked against tournament_name (some signals only live there).
_NONSERIOUS_TOURNAMENT_KEYWORDS = (
    "online", "オンライン",
    "テスト", "検証", "test", "sample",
    # Private/insider events (招待制 / 身内オフ)
    "帝国", "招待", "invitational", "身内", "内輪",
    # Character restriction (only signaled in tournament name sometimes, e.g. 念舞祭, ファルコン限定杯)
    "only", "限定", "縛り", "専用",
)


def _is_1on1_event(attr: dict) -> bool:
    labels = attr.get("labels") or {}
    rule = labels.get("game_rule")
    event_name_orig = attr.get("event_name") or ""
    event_name = event_name_orig.lower()
    tournament_name_orig = attr.get("tournament_name") or ""
    tournament_name = tournament_name_orig.lower()

    # Hard exclude: non-serious event signals (casual / character-only / beginner / items / online / test)
    for kw in _NONSERIOUS_EVENT_KEYWORDS:
        if kw in event_name or kw in event_name_orig:
            return False
    for kw in _NONSERIOUS_TOURNAMENT_KEYWORDS:
        if kw in tournament_name or kw in tournament_name_orig:
            return False

    if rule == "1on1":
        return True
    if rule in ("doubles", "crew-battle", "squad-strike", "oma-5", "random"):
        return False
    # Fallback: name heuristic
    if any(k in event_name for k in _EXCLUDE_KEYWORDS):
        return False
    if any(k in event_name for k in _SINGLE_KEYWORDS):
        return True
    # Default: assume 1on1 if name mentions "ultimate" or "smash" with no team markers
    return "ultimate" in event_name or "smash" in event_name or "スマ" in event_name_orig


def _load_json(path: Path) -> dict | None:
    try:
        with open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def _unwrap(blob):
    if isinstance(blob, dict) and "data" in blob:
        return blob["data"]
    return blob


def iter_tournaments(
    events_root: Path,
    region: str = "Japan",
    since_ts: int | None = None,
    until_ts: int | None = None,
    min_entrants: int = 2,
) -> Iterator[Tournament]:
    region_root = events_root / region
    if not region_root.is_dir():
        return

    seen_event_ids: set[int] = set()

    for dirpath, dirnames, filenames in os.walk(region_root):
        if "attr.json" not in filenames:
            continue
        if "standings.json" not in filenames:
            continue
        event_dir = Path(dirpath)
        attr = _load_json(event_dir / "attr.json")
        if attr is None:
            continue
        if not _is_1on1_event(attr):
            continue
        event_id = attr.get("event_id")
        if event_id is not None:
            if event_id in seen_event_ids:
                continue
            seen_event_ids.add(event_id)
        num_entrants = attr.get("num_entrants", 0) or 0
        if num_entrants < min_entrants:
            continue
        ts = attr.get("timestamp")
        if ts is None:
            continue
        if since_ts is not None and ts < since_ts:
            continue
        if until_ts is not None and ts >= until_ts:
            continue

        standings_blob = _load_json(event_dir / "standings.json")
        standings_raw = _unwrap(standings_blob) if standings_blob is not None else None
        if not isinstance(standings_raw, list):
            continue
        standings: list[tuple[int, int]] = []
        for s in standings_raw:
            if not isinstance(s, dict):
                continue
            place = s.get("placement")
            uid = s.get("user_id")
            if place is None or uid is None:
                continue
            standings.append((int(place), int(uid)))
        if len(standings) < min_entrants:
            continue
        standings.sort(key=lambda x: x[0])

        matches: list[Match] = []
        if "matches.json" in filenames:
            matches_blob = _load_json(event_dir / "matches.json")
            matches_raw = _unwrap(matches_blob) if matches_blob is not None else None
            if isinstance(matches_raw, list):
                for m in matches_raw:
                    if not isinstance(m, dict):
                        continue
                    if m.get("state") != 3:
                        continue
                    if m.get("dq") or m.get("cancel"):
                        continue
                    wid = m.get("winner_id")
                    lid = m.get("loser_id")
                    if wid is None or lid is None:
                        continue
                    if wid == lid:
                        continue
                    matches.append(
                        Match(
                            timestamp=ts,
                            winner_id=int(wid),
                            loser_id=int(lid),
                            event_path=str(event_dir),
                        )
                    )

        end_ts = attr.get("end_timestamp")
        yield Tournament(
            timestamp=ts,
            end_timestamp=int(end_ts) if end_ts is not None else None,
            event_path=str(event_dir),
            standings=standings,
            matches=matches,
        )


def load_all_tournaments(
    events_root: Path,
    region: str = "Japan",
    since_ts: int | None = None,
    until_ts: int | None = None,
    min_entrants: int = 2,
) -> list[Tournament]:
    tournaments = list(
        iter_tournaments(events_root, region, since_ts, until_ts, min_entrants)
    )
    tournaments.sort(key=lambda t: t.timestamp)
    return tournaments


# Backwards-compat helpers: older callers wanted a flat match list.
def iter_matches(
    events_root: Path,
    region: str = "Japan",
    since_ts: int | None = None,
    until_ts: int | None = None,
) -> Iterator[Match]:
    for t in iter_tournaments(events_root, region, since_ts, until_ts):
        for m in t.matches:
            yield m


def load_all_matches(
    events_root: Path,
    region: str = "Japan",
    since_ts: int | None = None,
    until_ts: int | None = None,
) -> list[Match]:
    matches = list(iter_matches(events_root, region, since_ts, until_ts))
    matches.sort(key=lambda m: m.timestamp)
    return matches


if __name__ == "__main__":
    import argparse
    import datetime as dt

    ap = argparse.ArgumentParser()
    ap.add_argument("--events-root", default="../smash_db_tournament/data/startgg/events")
    ap.add_argument("--region", default="Japan")
    ap.add_argument("--since", default=None, help="YYYY-MM-DD")
    ap.add_argument("--until", default=None, help="YYYY-MM-DD")
    args = ap.parse_args()

    since_ts = int(dt.datetime.fromisoformat(args.since).timestamp()) if args.since else None
    until_ts = int(dt.datetime.fromisoformat(args.until).timestamp()) if args.until else None

    tournaments = load_all_tournaments(Path(args.events_root), args.region, since_ts, until_ts)
    total_matches = sum(len(t.matches) for t in tournaments)
    total_standings = sum(len(t.standings) for t in tournaments)
    print(f"Loaded {len(tournaments):,} tournaments")
    print(f"  Total matches:   {total_matches:,}")
    print(f"  Total standings: {total_standings:,}")
    players = set()
    for t in tournaments:
        for _, uid in t.standings:
            players.add(uid)
    print(f"  Unique players:  {len(players):,}")
    if tournaments:
        print(f"  Date range: {dt.datetime.fromtimestamp(tournaments[0].timestamp)} -> {dt.datetime.fromtimestamp(tournaments[-1].timestamp)}")
