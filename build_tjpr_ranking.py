"""TJPR v1 + BT-gated-tour(M=20) ランキング計算 (production).

Outputs:
  ranking_eval/site/latest_tjpr_full.jsonl  — 1行/player、4 種ランキング + per-tournament 詳細 + rank/score 時系列
  ranking_eval/site/meta.json               — 計算メタ情報
"""
import argparse, json, math, re, time
import datetime as dt
from collections import defaultdict
from pathlib import Path

import numpy as np
import jpholiday
import sys; sys.path.insert(0, str(Path(__file__).parent))
from data_loader import load_all_tournaments
from build_latest_ranking import tournament_display_name
from smash_banzuke import build_de_losers_round_participants
from jjpr_v3 import placement_to_tier, load_users, format_display, jjpr_point
from raters.openskill_rater import OpenSkillBTRater

# ── Constants ──
OSK_BETA = 25.0 / 6.0
ELO_PER_UNIT = 400.0 / (math.log(10) * math.sqrt(2) * OSK_BETA)  # 29.48

EVENTS_ROOT = Path(__file__).parent.parent / "smash_db_tournament" / "data" / "startgg" / "events"
LOOKBACK_DAYS = 365 * 3
JJPR_LOOKBACK_DAYS = 365 * 2
TJPR_DEFAULT_RATE = 1500.0
JJPR_TOP_K = 6
SMAPA_PATTERN = re.compile(r'スマパ|Weekly Smash Party|Smash Party', re.IGNORECASE)

# プレ大会 (preliminary tournament) 検出
#   - JP: 「プレ大会」「プレオフ」「プレ予選」「プレローカル」など、プレ + 既知サフィックス
#   - JP: 「プレ」+ 漢字/空白/区切り記号/末尾 (= カタカナ拡張ではない)
#   - EN: 「Pre-XXX」「pre_XXX」 (ハイフン/アンダースコア区切り)
#   - EN: 「Pretournament」 (合成語)
#   - EN: 単独の word「pre」
# 単語中の「プレ」(プレミアム、supremo 等) はマッチさせない
PRE_PATTERN = re.compile(
    r'プレ(?:大会|トーナメント|トナメ|オフ|イベント|予選|戦|リリース|オープン|セッション|ローカル|シーズン)'
    r'|プレ(?=[\u4e00-\u9fff]|\s|[/／・\-‐\u3000\(\)\[\]【】「」『』]|$)'
    r'|(?<![A-Za-z])[Pp]re[\-_]'
    r'|(?<![A-Za-z])[Pp]retournament(?![A-Za-z])'
    r'|(?<![A-Za-z])[Pp]re(?![A-Za-z])'
)

LV1_PARAMS = (1700, 350, 1, 0.3)
LV2_PARAMS = (1900, 700, 3, 0.3)
LV3_FILTER = {'min_nent_gt': 24}                          # top 1024
LV4_FILTER = {'min_nent_gt': 24, 'weekend_only': True}    # top 512: 中規模土日
LV5_FILTER = {'min_nent_gt': 48, 'weekend_only': True}    # top 256: メダリスト級
GATED_M_TOUR = 20
SIGMA_FLOOR = 2.35  # BT-gated σ 下限 (覚醒選手の順位追従を強化、Top 8 τ +0.0186 改善)

# サイト表示用 TJPR スコア (順位に影響しない線形変換)
# display = score × TJPR_ELO_SCALE  (offset なし、0 スタート)
TJPR_ELO_SCALE = 100.0
TJPR_ELO_OFFSET = 0.0
BT_ELO_OFFSET = 1000.0

# 過去ランク snapshot を取る日数 (今日から N 日前)
# 2 年分・1 ヶ月刻み (30 日 × 1..24)
SNAPSHOT_DAYS = [30 * i for i in range(1, 25)]


def tournament_series(name: str) -> str:
    """大会名からシリーズ名を抽出 (番号要素・サブタイトルを除去してシリーズ統合)."""
    if not name: return ''
    # まず 第N回 prefix (漢数字対応、/ も含めて) を除去 — "第一回/幻月～..." → "幻月～..."
    s = re.sub(r'^第\s*[一二三四五六七八九十百千万零壱弐参肆伍陸漆捌玖拾\d]+\s*回\s*[/／]?\s*', '', name)
    # 先頭の 【...】 ラベル除去 — 「【第302回】スマACT」「【金曜】平日しのスマ」など
    s = re.sub(r'^\s*【[^】]*】\s*', '', s)
    s = s.split('/')[0].strip()  # 篝火#15/KAGARIBI#15 → 篝火#15
    # もう一度 第N回 prefix (split 後にも残る場合があるので)
    s = re.sub(r'^第\s*[一二三四五六七八九十百千万零壱弐参肆伍陸漆捌玖拾\d]+\s*回\s*', '', s)
    # 先頭の 【...】 もう一度
    s = re.sub(r'^\s*【[^】]*】\s*', '', s)
    # 日付プレフィックス除去: 11(火祝)上野スマコミ → 上野スマコミ。曜日 + 任意で「祝」「振休」「昼」「夜」「朝」等
    s = re.sub(r'^\d+\s*[\(（][月火水木金土日祝振休昼夜朝夕\s]+[\)）]\s*', '', s)
    s = re.sub(r'^\d+[\.\-\/]\d+\s*', '', s)
    # サブタイトル除去 (引用符・括弧)
    s = re.sub(r'\s*["""][^"""]*["""]\s*$', '', s)
    s = re.sub(r'\s*[（(][^)）]*[)）]\s*$', '', s)
    # アポストロフィ正規化
    s = re.sub(r"['']", '', s)
    # まず "#N + 後続サブタイトル" を greedy で除去 (例: 渋谷"達" #79 shibuya -tatsu → 渋谷"達")
    # # (U+0023) / ＃ (U+FF03) / ♯ (U+266F MUSIC SHARP SIGN) すべて対応
    s = re.sub(r'\s*[#＃♯]\s*\d+(?:\.\d+)?.*$', '', s)
    # "数字 + 半角英字サブタイトル" も iteration + ASCII subtitle と判断
    # 例: 渋谷"達"36 shibuya -tatsu → 渋谷"達"
    s = re.sub(r'(?<=\D)\d+(?:\.\d+)?\s*[A-Za-z\-][A-Za-z0-9\s\-]*\s*$', '', s)
    # 末尾の _N / Vol.N / " N" / 数字塊 / その N / Day N / Round N など (繰り返し)
    for _ in range(3):
        prev = s
        s = re.sub(r'_\s*\d+(?:\.\d+)?\s*$', '', s)
        s = re.sub(r'[Vv]ol\.?\s*\d+\s*$', '', s)
        s = re.sub(r'\s*その\s*\d+\s*$', '', s)                                              # 大菊月 その5
        s = re.sub(r'\s*[Dd]ay\s*\d+\s*$', '', s)                                            # Day 2
        s = re.sub(r'\s*[Rr]ound\s*\d+\s*$', '', s)                                          # Round 3
        s = re.sub(r'\s*シーズン\s*\d+\s*$', '', s)                                            # シーズン 5
        s = re.sub(r'\s*第[一二三四五六七八九十百千万零壱弐参肆伍陸漆捌玖拾]+\s*[幕回章節期戦]\s*$', '', s)  # 第壱幕、第零幕
        # 英序数: First/Second/.../1st/2nd
        s = re.sub(r'\s+(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth)\s*$', '', s, flags=re.IGNORECASE)
        s = re.sub(r'\s+\d+(?:st|nd|rd|th)\s*$', '', s, flags=re.IGNORECASE)
        s = re.sub(r'\s+\d+(?:\.\d+)?\s*$', '', s)
        # トレイル "数字 + _" や "数字 + -" は反復番号と判断 (例: カリスマSP17_ → カリスマSP)
        s = re.sub(r'\d+[_\-‐－]+\s*$', '', s)
        # トレイル数字 (直前が 非数字 かつ U/u でない場合のみ strip)
        # 例: ウメブラSP12 → ウメブラSP、カリスマSP17 → カリスマSP
        # 例外: マエスマU20 (U20 = Under 20 はそのまま)
        s = re.sub(r'(?<![Uu])(?<=\D)\d+(?:\.\d+)?\s*$', '', s).strip()
        if s == prev: break
    # 〜...〜 ペア or 末尾 〜 (#N strip 後にやる必要があるので最後)
    s = re.sub(r'\s*[～〜][^～〜]*?[～〜]\s*$', '', s)
    s = re.sub(r'\s*[～〜]\s*$', '', s)
    # 末尾のダッシュ・記号
    s = re.sub(r'\s*[-‐－〜～]+\s*$', '', s)
    # 末尾の感嘆符塊 (Fly High!! → Fly High、闘 ZONE!! → 闘 ZONE)
    s = re.sub(r'\s*[!！]+\s*$', '', s)
    # ブランド表記正規化: "Fly High" → "FlyHigh" (空白あり/なし両方の表記揺れを統合)
    s = re.sub(r'^[Ff]ly\s+[Hh]igh\b', 'FlyHigh', s)
    return s.strip() or name


def tournament_event_id(event_path: str) -> int | None:
    """attr.json から event_id を返す。失敗時は None。"""
    try:
        with open(Path(event_path) / "attr.json", "rb") as f:
            d = json.loads(f.read())
        return int(d.get("event_id")) if d.get("event_id") is not None else None
    except Exception:
        return None


def load_event_seeds(event_path: str) -> dict[int, int]:
    """seeds.json から {user_id: seed_num} を返す。実際に start.gg で使われたシード。"""
    try:
        with open(Path(event_path) / "seeds.json", "rb") as f:
            d = json.loads(f.read())
        items = d if isinstance(d, list) else (d.get("data") or [])
        out = {}
        for it in items:
            uid = it.get("user_id"); sn = it.get("seed_num")
            if uid is None or sn is None: continue
            out[int(uid)] = int(sn)
        return out
    except Exception:
        return {}


# SPR (Seed Performance Rating) = W2W(seed) - W2W(place)
# W2W = "Wins to Win" = DE bracket でその placement に到達した時の勝ち上がりラウンド数
# Ref: ranking_eval/spr_uf_analysis.py (PGstats 由来)
def _build_de_w2w_bounds(max_w2w=30):
    bounds = []
    for n in range(max_w2w + 1):
        if n == 0: p = 1
        elif n == 1: p = 2
        elif n % 2 == 0: p = 2 ** (n // 2) + 1
        else: p = 3 * 2 ** ((n - 3) // 2) + 1
        bounds.append((p, n))
    return bounds

_DE_W2W_BOUNDS = _build_de_w2w_bounds()

def placement_to_w2w(place: int) -> int:
    if place is None or place < 1:
        return 0
    result = 0
    for p, w in _DE_W2W_BOUNDS:
        if p <= place:
            result = w
        else:
            break
    return result


def is_weekend_date(d: dt.date) -> bool:
    if d.weekday() >= 5:
        return True
    return jpholiday.is_holiday(d)


def is_weekend_range(start_d: dt.date, end_d: dt.date) -> bool:
    """開始日〜終了日のいずれかが土日祝なら True."""
    if end_d < start_d:
        end_d = start_d
    delta = (end_d - start_d).days
    if delta > 14:
        # 長期イベント (start.gg の endAt がブラケット閉鎖まで含むケース) は start 単独で判定
        return is_weekend_date(start_d)
    for i in range(delta + 1):
        if is_weekend_date(start_d + dt.timedelta(days=i)):
            return True
    return False


def t_passes(meta: dict, filt: dict | None) -> bool:
    if filt is None:
        return True
    if filt.get('min_nent_gt') is not None and meta['nent'] <= filt['min_nent_gt']:
        return False
    if filt.get('exclude_smapa') and meta['is_smapa']:
        return False
    if filt.get('weekend_only') and not meta['is_weekend']:
        return False
    return True


def td_exp(days: int, r: float = 0.97) -> float:
    return r ** (days / 30.0)


# ── BT learners ──
def learn_bt_all(prior, t_meta_by_id):
    b = OpenSkillBTRater()
    rating_history = defaultdict(list)
    for t in prior:
        match_uids = set()
        for m in t.matches:
            match_uids.add(m.winner_id); match_uids.add(m.loser_id)
        before_ratings = {uid: b._get(uid).ordinal() for uid in match_uids}
        for m in t.matches:
            b.update_match(m.winner_id, m.loser_id, m.timestamp)
        for uid in match_uids:
            after = b.rating(uid)
            rating_history[uid].append((id(t), after, after - before_ratings.get(uid, 0)))
    return {uid: b.rating(uid) for uid in b.ratings}, rating_history


def learn_bt_gated_tour(prior, t_meta_by_id, M=20):
    b = OpenSkillBTRater()
    tour_count = defaultdict(int)
    bt_used = defaultdict(dict)
    rating_history = defaultdict(list)
    # 試合単位の勝利 BT delta を記録 (winner uid -> [(tid, opp_uid, delta), ...])
    match_wins = defaultdict(list)
    for t in prior:
        meta = t_meta_by_id[id(t)]
        is_wk = meta['is_weekend']
        participants = set()
        for m in t.matches:
            participants.add(m.winner_id); participants.add(m.loser_id)
        before_ratings = {uid: b._get(uid).ordinal() for uid in participants}
        any_used = {uid: False for uid in participants}
        for m in t.matches:
            wc, lc = tour_count[m.winner_id], tour_count[m.loser_id]
            update_w = is_wk or (wc <= M)
            update_l = is_wk or (lc <= M)
            if update_w or update_l:
                w_r = b._get(m.winner_id)
                l_r = b._get(m.loser_id)
                before_w = w_r.ordinal()
                new_ratings = b.model.rate([[w_r], [l_r]], ranks=[1, 2])
                if update_w:
                    nw = new_ratings[0][0]
                    if SIGMA_FLOOR > 0 and nw.sigma < SIGMA_FLOOR:
                        nw = b.model.rating(mu=nw.mu, sigma=SIGMA_FLOOR)
                    after_w = nw.ordinal()
                    d_match = after_w - before_w
                    if d_match > 0:
                        match_wins[m.winner_id].append((id(t), m.loser_id, d_match))
                    b.ratings[m.winner_id] = nw
                    any_used[m.winner_id] = True
                if update_l:
                    nl = new_ratings[1][0]
                    if SIGMA_FLOOR > 0 and nl.sigma < SIGMA_FLOOR:
                        nl = b.model.rating(mu=nl.mu, sigma=SIGMA_FLOOR)
                    b.ratings[m.loser_id] = nl
                    any_used[m.loser_id] = True
        for uid in participants:
            after = b.rating(uid)
            bt_used[uid][id(t)] = any_used[uid]
            rating_history[uid].append((id(t), after, after - before_ratings[uid]))
        for uid in participants:
            tour_count[uid] += 1
    return {uid: b.rating(uid) for uid in b.ratings}, bt_used, rating_history, tour_count, match_wins


# ── Banzuke ──
def precompute_banzuke(prior, eval_date, normalized, t_meta_by_id, default_rate):
    cached = []
    for pt_t in prior:
        meta = t_meta_by_id[id(pt_t)]
        nent_p = meta['nent']
        tdate = dt.datetime.fromtimestamp(pt_t.timestamp)
        if tdate > eval_date:
            continue
        days = (eval_date - tdate).days
        seen = set(); parts = []
        for _, uid in pt_t.standings:
            if uid in seen:
                continue
            seen.add(uid); parts.append((uid, normalized.get(uid, default_rate)))
        n = len(parts)
        if n < 2:
            continue
        parts.sort(key=lambda x: x[1])
        norm_arr = np.array([p[1] for p in parts])
        lr_rounds = build_de_losers_round_participants(n)
        total_lr = len(lr_rounds)
        if total_lr == 0:
            continue
        round_indices = [np.array([s for s in sr if s < n], dtype=np.int64) for sr in lr_rounds]
        max_tier_n = placement_to_tier(n)
        players = []; seen2 = set()
        for place, uid in pt_t.standings:
            if uid in seen2:
                continue
            seen2.add(uid)
            rw = min(max(0, max_tier_n - placement_to_tier(place)), total_lr)
            if rw > 0:
                players.append((uid, rw, place))
        cached.append({
            'norm': norm_arr,
            'rounds': round_indices,
            'players': players,
            'days': days,
            't_id': id(pt_t),
            'nent': nent_p,
            'is_weekend': meta['is_weekend'],
            'is_smapa': meta['is_smapa'],
        })
    return cached


def compute_bz_with_detail(cache, base, floor, topN, pd, pfilter=None, tfilter=None):
    eps = 0.01
    pe = defaultdict(list)
    for t in cache:
        if tfilter is not None:
            if tfilter.get('min_nent_gt') is not None and t['nent'] <= tfilter['min_nent_gt']:
                continue
            if tfilter.get('exclude_smapa') and t['is_smapa']:
                continue
            if tfilter.get('weekend_only') and not t['is_weekend']:
                continue
        age_decay = td_exp(t['days'])
        clamped = np.maximum(t['norm'], floor)
        rp = []
        for idx in t['rounds']:
            if len(idx):
                r = clamped[idx]
                g = 1.0 - 1.0 / (1.0 + np.power(10.0, (r - base) / 400.0))
                rp.append(eps + np.maximum(0, g).mean())
            else:
                rp.append(eps)
        for uid, rw, place in t['players']:
            if pfilter is not None and uid not in pfilter:
                continue
            raw_pts = sum(rp[:rw])
            if raw_pts > 0:
                pe[uid].append((raw_pts, age_decay, t['t_id'], place))
    scores = {}
    contributions = defaultdict(list)
    for uid, entries in pe.items():
        entries.sort(key=lambda x: -(x[0] * x[1]))
        total = 0.0
        for i, (raw_pts, age_decay, t_id, place) in enumerate(entries):
            pos_factor = 1.0 if i < topN else pd ** (i - topN + 1)
            weighted = raw_pts * age_decay * pos_factor
            total += weighted
            contributions[uid].append({
                't_id': t_id,
                'raw_points': raw_pts,
                'age_decay': age_decay,
                'pos_factor': pos_factor,
                'weighted': weighted,
                'rank_in_player': i,
            })
        scores[uid] = total
    return scores, contributions


def build_tjpr_v1_with_detail(cache):
    # 5 層 cascade: Lv1 全員 → Lv2 top2048 → Lv3 top1024 (nent>24) → Lv4 top512 (nent>24+wk) → Lv5 top256 (nent>48+wk)
    sc1, ct1 = compute_bz_with_detail(cache, *LV1_PARAMS)
    filt2 = set(uid for uid, _ in sorted(sc1.items(), key=lambda x: -x[1])[:2048])
    sc2, ct2 = compute_bz_with_detail(cache, *LV2_PARAMS, pfilter=filt2)
    filt3 = set(uid for uid, _ in sorted(sc2.items(), key=lambda x: -x[1])[:1024])
    sc3, ct3 = compute_bz_with_detail(cache, *LV2_PARAMS, pfilter=filt3, tfilter=LV3_FILTER)
    filt4 = set(uid for uid, _ in sorted(sc3.items(), key=lambda x: -x[1])[:512])
    sc4, ct4 = compute_bz_with_detail(cache, *LV2_PARAMS, pfilter=filt4, tfilter=LV4_FILTER)
    filt5 = set(uid for uid, _ in sorted(sc4.items(), key=lambda x: -x[1])[:256])
    sc5, ct5 = compute_bz_with_detail(cache, *LV2_PARAMS, pfilter=filt5, tfilter=LV5_FILTER)
    level_scores = [sc1, sc2, sc3, sc4, sc5]
    level_contribs = [ct1, ct2, ct3, ct4, ct5]
    plv = {}
    plv_score = {}
    plv_contribs = {}
    # Per-level scores for ALL players (not just their highest reached level)
    all_level_scores = defaultdict(lambda: {1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0, 5: 0.0})
    for uid in level_scores[0].keys():
        for i in range(len(level_scores) - 1, -1, -1):
            if uid in level_scores[i]:
                plv[uid] = i + 1
                plv_score[uid] = level_scores[i][uid]
                plv_contribs[uid] = level_contribs[i][uid]
                break
        for i in range(len(level_scores)):
            if uid in level_scores[i]:
                all_level_scores[uid][i + 1] = level_scores[i][uid]
    final = sorted(plv.items(), key=lambda x: (-x[1], -plv_score[x[0]]))
    ranks = {u: r for r, (u, _) in enumerate(final, 1)}
    return ranks, plv, plv_score, plv_contribs, dict(all_level_scores)


# ── JJPR v3 ──
def build_jjpr_v3_with_detail(prior, eval_date, t_meta_by_id, top_k=6):
    player_entries = defaultdict(list)
    for t in prior:
        meta = t_meta_by_id[id(t)]
        tdate = dt.datetime.fromtimestamp(t.timestamp)
        if tdate > eval_date:
            continue
        days_elapsed = (eval_date - tdate).days
        seen = set()
        for place, uid in t.standings:
            if uid in seen:
                continue
            seen.add(uid)
            pt = jjpr_point(meta['nent'], place, days_elapsed)
            if pt > 0:
                player_entries[uid].append((pt, days_elapsed, id(t), place))
    scores = {}
    contribs = defaultdict(list)
    for uid, entries in player_entries.items():
        entries.sort(key=lambda x: -x[0])
        total = 0.0
        for i, (pt, days, t_id, place) in enumerate(entries):
            counted = i < top_k
            if counted:
                total += pt
            contribs[uid].append({'t_id': t_id, 'points': pt, 'counted': counted, 'place': place})
        scores[uid] = total
    sorted_u = sorted(scores.items(), key=lambda x: -x[1])
    ranks = {u: r + 1 for r, (u, _) in enumerate(sorted_u)}
    return ranks, scores, contribs


# ── Normalize ──
# normalize_bt: TJPR の Banzuke gain 入力用に max=2500 シフト (順位に影響しない)
def normalize_bt(bt_ord):
    if not bt_ord:
        return {}
    elo = {uid: r * ELO_PER_UNIT for uid, r in bt_ord.items()}
    max_r = max(elo.values())
    return {uid: r - (max_r - 2500.0) for uid, r in elo.items()}


# bt_to_elo_display: サイト表示用の Elo 線形変換 (ordinal × 29.48 + BT_ELO_OFFSET)
def bt_to_elo_display(bt_ord):
    return {uid: r * ELO_PER_UNIT + BT_ELO_OFFSET for uid, r in bt_ord.items()}


def rank_avg(ranks_list, all_uids, score_lists=None, return_metrics=False):
    """順位平均で sort。score_lists が与えられた場合、tie は score 平均 (大きい順) で解消.

    return_metrics=True で (ranks, avg_rank, avg_score) を返す。
    """
    default_rank = len(all_uids) + 1
    avg_rank = {}
    for u in all_uids:
        avg_rank[u] = sum(rk.get(u, default_rank) for rk in ranks_list) / len(ranks_list)
    avg_score = {}
    if score_lists:
        for u in all_uids:
            avg_score[u] = sum(sc.get(u, 0.0) for sc in score_lists) / len(score_lists)
        sorted_u = sorted(all_uids, key=lambda u: (avg_rank[u], -avg_score[u]))
    else:
        sorted_u = sorted(all_uids, key=lambda u: avg_rank[u])
    ranks = {u: i + 1 for i, u in enumerate(sorted_u)}
    if return_metrics:
        return ranks, avg_rank, avg_score
    return ranks


def to_rank(ratings):
    sorted_u = sorted(ratings.items(), key=lambda x: -x[1])
    return {u: r + 1 for r, (u, _) in enumerate(sorted_u)}


# ── Snapshot computation (light, no per-tournament details) ──
def compute_ranks_at(all_tournaments, snapshot_date, t_meta_by_id):
    """指定 snapshot_date における 4 種類のランク + TJPR/BT スコアを返す."""
    snap_ts = int(snapshot_date.timestamp())
    lookback_ts = int((snapshot_date - dt.timedelta(days=LOOKBACK_DAYS)).timestamp())
    jjpr_lookback_ts = int((snapshot_date - dt.timedelta(days=JJPR_LOOKBACK_DAYS)).timestamp())
    prior = [t for t in all_tournaments if t.timestamp < snap_ts and t.timestamp >= lookback_ts]
    jjpr_prior = [t for t in all_tournaments if t.timestamp < snap_ts and t.timestamp >= jjpr_lookback_ts]
    if not prior:
        return {'tjpr_ranks': {}, 'tjpr_levels': {}, 'bt_gated_ranks': {}, 'ensemble_ranks': {},
                'jjpr_ranks': {}, 'bt_flat_ranks': {},
                'tjpr_scores': {}, 'tjpr_elo': {}, 'bt_gated_elo': {}, 'bt_flat_elo': {},
                'jjpr_scores': {}}

    # BT (all) for normalization
    bt_all = OpenSkillBTRater()
    for t in prior:
        for m in t.matches:
            bt_all.update_match(m.winner_id, m.loser_id, m.timestamp)
    bt_all_ord = {uid: bt_all.rating(uid) for uid in bt_all.ratings}
    norm_bt = normalize_bt(bt_all_ord)

    # BT-gated-tour
    bt_g = OpenSkillBTRater()
    tour_c = defaultdict(int)
    for t in prior:
        meta = t_meta_by_id[id(t)]
        is_wk = meta['is_weekend']
        participants = set()
        for m in t.matches:
            participants.add(m.winner_id); participants.add(m.loser_id)
        for m in t.matches:
            wc, lc = tour_c[m.winner_id], tour_c[m.loser_id]
            update_w = is_wk or (wc <= GATED_M_TOUR)
            update_l = is_wk or (lc <= GATED_M_TOUR)
            if update_w or update_l:
                w_r = bt_g._get(m.winner_id)
                l_r = bt_g._get(m.loser_id)
                new_ratings = bt_g.model.rate([[w_r], [l_r]], ranks=[1, 2])
                if update_w: bt_g.ratings[m.winner_id] = new_ratings[0][0]
                if update_l: bt_g.ratings[m.loser_id] = new_ratings[1][0]
        for uid in participants:
            tour_c[uid] += 1
    bt_g_ord = {uid: bt_g.rating(uid) for uid in bt_g.ratings}
    norm_bt_g = normalize_bt(bt_g_ord)

    # TJPR v1 (BT-gated rates を Banzuke の seed input として使用)
    cache = precompute_banzuke(prior, snapshot_date, norm_bt_g, t_meta_by_id, TJPR_DEFAULT_RATE)
    tjpr_ranks, tjpr_levels, tjpr_scores, _, _ = build_tjpr_v1_with_detail(cache)
    # サイト表示用の Elo: シフトなしの線形変換 (順位は不変)
    tjpr_elo = {uid: s * TJPR_ELO_SCALE + TJPR_ELO_OFFSET for uid, s in tjpr_scores.items()}
    bt_g_elo_disp = bt_to_elo_display(bt_g_ord)
    bt_all_elo_disp = bt_to_elo_display(bt_all_ord)

    # JJPR v3
    jjpr_ranks, jjpr_scores, _ = build_jjpr_v3_with_detail(jjpr_prior, snapshot_date, t_meta_by_id, top_k=JJPR_TOP_K)

    # Ensemble (tie-break by avg display score)
    bt_g_ranks = to_rank(bt_g_ord)
    all_uids = set(tjpr_ranks) | set(bt_g_ranks)
    ens_ranks = rank_avg([tjpr_ranks, bt_g_ranks], all_uids,
                          score_lists=[tjpr_elo, bt_g_elo_disp])
    return {
        'tjpr_ranks': tjpr_ranks,
        'tjpr_levels': tjpr_levels,
        'bt_gated_ranks': bt_g_ranks,
        'ensemble_ranks': ens_ranks,
        'jjpr_ranks': jjpr_ranks,
        'bt_flat_ranks': to_rank(bt_all_ord),
        'tjpr_scores': tjpr_scores,
        'tjpr_elo': tjpr_elo,
        'bt_gated_elo': bt_g_elo_disp,
        'bt_flat_elo': bt_all_elo_disp,
        'jjpr_scores': jjpr_scores,
    }


# ── Main ──
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--eval-date", default=None, help="YYYY-MM-DD, defaults to today")
    p.add_argument("--out", default="ranking_eval/site/latest_tjpr_full.jsonl")
    p.add_argument("--meta-out", default="ranking_eval/site/meta.json")
    p.add_argument("--min-entrants", type=int, default=8)
    p.add_argument("--no-snapshots", action="store_true", help="Skip historical rank snapshots (faster)")
    args = p.parse_args()

    eval_date = dt.datetime.now() if args.eval_date is None else dt.datetime.fromisoformat(args.eval_date)
    print(f"eval_date = {eval_date.date()}", flush=True)
    data_start = eval_date - dt.timedelta(days=LOOKBACK_DAYS + 30)

    print("Loading tournaments ...", flush=True)
    t0 = time.time()
    all_tournaments = load_all_tournaments(
        EVENTS_ROOT, "Japan",
        since_ts=int(data_start.timestamp()),
        until_ts=int(eval_date.timestamp()),
        min_entrants=args.min_entrants)
    all_tournaments.sort(key=lambda t: t.timestamp)
    print(f"  {len(all_tournaments)} tournaments loaded (elapsed {time.time()-t0:.0f}s)", flush=True)

    # ── DQ no-show プレイヤーを大会から除外 ──
    # 1 試合もせずに DQ したプレイヤーは standings から削除する (= 不参加扱い)。
    # これにより他のプレイヤーが「強いプレイヤーを破ったように見える」ことや、
    # 大会規模 nent の不当な水増しが起こらない。
    print("Filtering DQ no-shows ...", flush=True)
    n_no_show = 0
    n_filtered_tournaments = 0
    for t in all_tournaments:
        if not t.matches: continue  # match データなしの大会は変更しない
        played = set()
        for m in t.matches:
            played.add(m.winner_id); played.add(m.loser_id)
        if not played: continue
        original_n = len(t.standings)
        filtered = [(p, u) for (p, u) in t.standings if u in played]
        if not filtered: continue
        if len(filtered) < original_n:
            n_no_show += original_n - len(filtered)
            n_filtered_tournaments += 1
            t.standings = filtered
    print(f"  Removed {n_no_show} DQ no-show entries from {n_filtered_tournaments} tournaments", flush=True)

    print("Computing metadata ...", flush=True)
    t_meta_by_id = {}
    for t in all_tournaments:
        tname, ename, nent_attr = tournament_display_name(t.event_path)
        # nent: フィルター後の standings 数を使う (DQ 無参加を除外したサイズ)
        nent = len(t.standings) or nent_attr or 0
        d = dt.datetime.fromtimestamp(t.timestamp).date()
        end_ts = t.end_timestamp if t.end_timestamp is not None else t.timestamp
        end_d = dt.datetime.fromtimestamp(end_ts).date()
        # 開催期間中 (start〜end) のいずれかが土日祝なら weekend 扱い
        is_wk_real = is_weekend_range(d, end_d)
        is_pre = bool(PRE_PATTERN.search(tname or '')) or bool(PRE_PATTERN.search(ename or ''))
        # プレ大会は計算上は平日扱い (BT-gated gating / Banzuke weekend-only filter で平日相当)
        is_wk = is_wk_real and not is_pre
        eid = tournament_event_id(t.event_path)
        t_meta_by_id[id(t)] = {
            'event_id': eid,
            'nent': nent,
            'tname': tname or '',
            'ename': ename or '',
            'date': d.isoformat(),
            'end_date': end_d.isoformat(),
            'is_smapa': bool(SMAPA_PATTERN.search(tname or '')) or bool(SMAPA_PATTERN.search(ename or '')),
            'is_weekend': is_wk,
            'is_weekend_real': is_wk_real,  # 表示用: 実暦の土日祝
            'is_pre': is_pre,
        }

    placements_per_t = {}
    for t in all_tournaments:
        seen = set()
        place_map = {}
        for p, u in t.standings:
            if u in seen: continue
            seen.add(u); place_map[u] = p
        placements_per_t[id(t)] = place_map

    # Phase 1: Current rankings (with full per-tournament details)
    print("Training BT (all) ...", flush=True)
    bt_all_ord, bt_all_hist = learn_bt_all(all_tournaments, t_meta_by_id)
    print(f"  {len(bt_all_ord)} players (elapsed {time.time()-t0:.0f}s)", flush=True)
    norm_bt = normalize_bt(bt_all_ord)

    print(f"Training BT-gated-tour(M={GATED_M_TOUR}) ...", flush=True)
    bt_gated_ord, bt_used, bt_gated_hist, tour_count, match_wins = learn_bt_gated_tour(all_tournaments, t_meta_by_id, M=GATED_M_TOUR)
    norm_bt_gated = normalize_bt(bt_gated_ord)
    print(f"  {len(bt_gated_ord)} players (elapsed {time.time()-t0:.0f}s)", flush=True)

    print("Building TJPR v1 Banzuke (using BT-gated rates as Banzuke seed input) ...", flush=True)
    cache = precompute_banzuke(all_tournaments, eval_date, norm_bt_gated, t_meta_by_id, TJPR_DEFAULT_RATE)
    tjpr_ranks, tjpr_levels, tjpr_scores, tjpr_contribs, tjpr_level_scores = build_tjpr_v1_with_detail(cache)
    print(f"  {len(tjpr_ranks)} players (elapsed {time.time()-t0:.0f}s)", flush=True)

    print("Building JJPR v3 ...", flush=True)
    jjpr_prior = [t for t in all_tournaments
                  if t.timestamp >= int((eval_date - dt.timedelta(days=JJPR_LOOKBACK_DAYS)).timestamp())]
    jjpr_ranks, jjpr_scores, jjpr_contribs = build_jjpr_v3_with_detail(jjpr_prior, eval_date, t_meta_by_id, top_k=JJPR_TOP_K)
    print(f"  {len(jjpr_ranks)} players (elapsed {time.time()-t0:.0f}s)", flush=True)

    # サイト表示用 Elo: 順位に影響しない線形変換 (ensemble tie-break で使う)
    tjpr_elo = {uid: s * TJPR_ELO_SCALE + TJPR_ELO_OFFSET for uid, s in tjpr_scores.items()}
    norm_bt_gated_disp = bt_to_elo_display(bt_gated_ord)
    norm_bt_disp = bt_to_elo_display(bt_all_ord)
    max_tjpr = max(tjpr_scores.values()) if tjpr_scores else 1.0
    print(f"  TJPR display Elo: score × {TJPR_ELO_SCALE} (max raw score = {max_tjpr:.2f} → display {max_tjpr*TJPR_ELO_SCALE:.0f})", flush=True)

    print("Computing ensemble rank (tie-break by avg display score) ...", flush=True)
    bt_gated_ranks = to_rank(bt_gated_ord)
    all_uids = set(tjpr_ranks) | set(bt_gated_ranks)
    ensemble_ranks, ensemble_avg_rank, ensemble_avg_score = rank_avg(
        [tjpr_ranks, bt_gated_ranks], all_uids,
        score_lists=[tjpr_elo, norm_bt_gated_disp], return_metrics=True)
    bt_all_ranks = to_rank(bt_all_ord)

    # Per-tournament seed/SPR (start.gg の seeds.json から実際のシードを使う)
    # 同時に per-match UF (Upset Factor) を計算してプレイヤー別の max UF を記録。
    # UF は BT-gated と同じ gating ロジック (土日 or winner.tour_count <= M で勝った match のみ集計対象) を適用。
    print("Loading seeds.json + computing per-tournament SPR + per-match UF (gated) ...", flush=True)
    t_seed_info = {}  # t_id -> {uid -> {'seed': int, 'place': int, 'spr': int}}
    player_max_uf = {}  # uid -> dict (gated; for max-UF highlight on player page)
    uf_tour_count = defaultdict(int)  # mirror of learn_bt_gated_tour's tour_count for gating UF
    player_match_count = defaultdict(int)  # uid -> total matches played (winner or loser)
    # ── 実績バッチ用カウンター (2024-01-01 以降のみ) ──
    SINCE_2024_TS = int(dt.datetime(2024, 1, 1).timestamp())
    player_max_uf_ach = {}        # uid -> {'uf', 'opp_uid', 'opp_seed', 'winner_seed', ...} no-gating, since 2024
    player_max_spr_ach = {}       # uid -> {'spr', 'seed', 'place', ...}
    player_tour_count_2024 = defaultdict(int)
    player_match_count_2024 = defaultdict(int)
    player_win_count_2024 = defaultdict(int)
    player_vs_opp_count = defaultdict(lambda: defaultdict(int))  # uid -> opp -> count (since 2024)
    n_with_seeds = 0
    for t in all_tournaments:
        tid = id(t)
        placements = placements_per_t.get(tid, {})
        if not placements: continue
        # Count matches per player
        for m in t.matches:
            player_match_count[m.winner_id] += 1
            player_match_count[m.loser_id] += 1
        seeds_map = load_event_seeds(t.event_path)  # uid -> seed_num (実シード)
        if seeds_map: n_with_seeds += 1
        per_player = {}
        for u, place in placements.items():
            if place is None or place < 1: continue
            seed = seeds_map.get(u)
            if seed is None: continue
            spr = placement_to_w2w(seed) - placement_to_w2w(place)
            per_player[u] = {'seed': seed, 'place': place, 'spr': spr}
        t_seed_info[tid] = per_player
        # UF: gating 付き
        meta_t = t_meta_by_id[tid]
        is_wk = meta_t['is_weekend']
        participants_t = set()
        for m in t.matches:
            participants_t.add(m.winner_id); participants_t.add(m.loser_id)
        for m in t.matches:
            sw = seeds_map.get(m.winner_id)
            sl = seeds_map.get(m.loser_id)
            if sw is None or sl is None: continue
            if sw <= sl: continue  # not an upset
            # BT-gated gating: winner's rating updates only if weekend or winner.tour_count <= M
            wc = uf_tour_count[m.winner_id]
            if not (is_wk or wc <= GATED_M_TOUR):
                continue  # match not counted for winner — skip UF
            uf = placement_to_w2w(sw) - placement_to_w2w(sl)
            if uf <= 0: continue
            cur = player_max_uf.get(m.winner_id)
            if cur is None or uf > cur['uf']:
                player_max_uf[m.winner_id] = {
                    'uf': uf,
                    'opp_uid': m.loser_id,
                    'winner_seed': sw,
                    'opp_seed': sl,
                    'event_id': meta_t.get('event_id'),
                    'tournament_name': meta_t.get('tname'),
                    'event_name': meta_t.get('ename'),
                    'date': meta_t.get('date'),
                }
        # Advance tour_count for all participants (mirroring learn_bt_gated_tour)
        for uid in participants_t:
            uf_tour_count[uid] += 1
        # ── 2024+ 実績バッチ用カウンター (gating なし、since 2024) ──
        if t.timestamp >= SINCE_2024_TS:
            for uid_p in participants_t:
                player_tour_count_2024[uid_p] += 1
            for m in t.matches:
                player_match_count_2024[m.winner_id] += 1
                player_match_count_2024[m.loser_id] += 1
                player_win_count_2024[m.winner_id] += 1
                player_vs_opp_count[m.winner_id][m.loser_id] += 1
                player_vs_opp_count[m.loser_id][m.winner_id] += 1
                # UF achievement (no gating)
                sw = seeds_map.get(m.winner_id)
                sl = seeds_map.get(m.loser_id)
                if sw is not None and sl is not None and sw > sl:
                    uf = placement_to_w2w(sw) - placement_to_w2w(sl)
                    if uf > 0:
                        cur = player_max_uf_ach.get(m.winner_id)
                        if cur is None or uf > cur['uf']:
                            player_max_uf_ach[m.winner_id] = {
                                'uf': uf,
                                'opp_uid': m.loser_id,
                                'winner_seed': sw,
                                'opp_seed': sl,
                                'event_id': meta_t.get('event_id'),
                                'tournament_name': meta_t.get('tname'),
                                'date': meta_t.get('date'),
                            }
            # SPR achievement (per player per tournament)
            for u, info in per_player.items():
                spr = info.get('spr', 0)
                if spr <= 0: continue
                cur = player_max_spr_ach.get(u)
                if cur is None or spr > cur['spr']:
                    player_max_spr_ach[u] = {
                        'spr': spr,
                        'seed': info['seed'],
                        'place': info['place'],
                        'event_id': meta_t.get('event_id'),
                        'tournament_name': meta_t.get('tname'),
                        'date': meta_t.get('date'),
                    }
    print(f"  {n_with_seeds}/{len(all_tournaments)} tournaments have seeds.json", flush=True)
    print(f"  {len(player_max_uf)} players have at least one (gated) upset on record", flush=True)
    print(f"  {len(player_max_uf_ach)} / {len(player_max_spr_ach)} players have UF / SPR achievement records (since 2024)", flush=True)

    # Phase 2: Snapshot rankings at past dates
    snapshots = {}
    if not args.no_snapshots:
        print(f"\nComputing snapshots (ranks + Elo) at {SNAPSHOT_DAYS} days ago ...", flush=True)
        for days in SNAPSHOT_DAYS:
            snap_date = eval_date - dt.timedelta(days=days)
            s_t0 = time.time()
            snapshots[days] = compute_ranks_at(all_tournaments, snap_date, t_meta_by_id)
            print(f"  {days}d ago ({snap_date.date()}): {len(snapshots[days]['tjpr_ranks'])} players, {time.time()-s_t0:.0f}s", flush=True)

    print("\nLoading user names ...", flush=True)
    users = load_users()

    # Tournament summaries
    tournament_summary = {}
    for tid, m in t_meta_by_id.items():
        tournament_summary[tid] = {
            'event_id': m.get('event_id'),
            'date': m['date'],
            'end_date': m.get('end_date'),
            'name': m['tname'],
            'event': m['ename'],
            'nent': m['nent'],
            'is_weekend': m['is_weekend'],
            'is_weekend_real': m.get('is_weekend_real', m['is_weekend']),
            'is_smapa': m['is_smapa'],
            'is_pre': m.get('is_pre', False),
        }

    print("Building per-player JSONL + per-player JSON files ...", flush=True)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    players_dir = out_path.parent / "players"
    tournaments_dir = out_path.parent / "tournaments"
    # Clean and recreate players/ + tournaments/
    import shutil
    if players_dir.exists(): shutil.rmtree(players_dir)
    if tournaments_dir.exists(): shutil.rmtree(tournaments_dir)
    players_dir.mkdir(parents=True, exist_ok=True)
    tournaments_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    sorted_by_ens = sorted(ensemble_ranks.items(), key=lambda x: x[1])
    n_total = len(sorted_by_ens)
    # Accumulator: t_id -> { uid -> entry-with-display+global_ranks }
    per_tournament_data = defaultdict(dict)
    # Display name cache for unrated attendees
    display_cache = {}

    with out_path.open('w') as fp:
        for uid, ens_rank in sorted_by_ens:
            tj_level = tjpr_levels.get(uid, 0)
            tj_score = tjpr_scores.get(uid, 0.0)
            tj_elo = tjpr_elo.get(uid, 0.0)
            tj_rank = tjpr_ranks.get(uid, 0)
            bt_rank = bt_gated_ranks.get(uid, 0)
            bt_ord = bt_gated_ord.get(uid, 0.0)
            bt_elo = norm_bt_gated_disp.get(uid, 0.0)
            jj_rank = jjpr_ranks.get(uid, 0)
            jj_score = jjpr_scores.get(uid, 0.0)
            tc = tour_count.get(uid, 0)
            display = format_display(users.get(uid), uid)

            tournament_entries = []
            seen_tids = set()
            for c in tjpr_contribs.get(uid, []):
                tid = c['t_id']
                seen_tids.add(tid)
                tsum = tournament_summary.get(tid)
                if tsum is None: continue
                pmap = placements_per_t.get(tid, {})
                place = pmap.get(uid, None)
                bt_delta = 0.0; bt_used_flag = False
                for entry in bt_gated_hist.get(uid, []):
                    if entry[0] == tid:
                        bt_delta = entry[2]
                        bt_used_flag = bt_used.get(uid, {}).get(tid, False)
                        break
                jjpr_pts = 0.0
                for jc in jjpr_contribs.get(uid, []):
                    if jc['t_id'] == tid:
                        jjpr_pts = jc['points']
                        break
                si = t_seed_info.get(tid, {}).get(uid)
                tournament_entries.append({
                    'event_id': tsum.get('event_id'),
                    'date': tsum['date'],
                    'name': tsum['name'],
                    'event': tsum['event'],
                    'nent': tsum['nent'],
                    'place': place,
                    'seed': si['seed'] if si else None,
                    'spr': si['spr'] if si else None,
                    'is_weekend': tsum['is_weekend'],
                    'is_weekend_real': tsum.get('is_weekend_real', tsum['is_weekend']),
                    'is_smapa': tsum['is_smapa'],
                    'is_pre': tsum.get('is_pre', False),
                    'tjpr_lv': tj_level,
                    'tjpr_raw': c['raw_points'],
                    'tjpr_age': c['age_decay'],
                    'tjpr_pos': c['pos_factor'],
                    'tjpr_w': c['weighted'],
                    'tjpr_counted': (c['rank_in_player'] < LV2_PARAMS[2]) if tj_level >= 2 else (c['rank_in_player'] < LV1_PARAMS[2]),
                    'bt_used': bt_used_flag,
                    'bt_d': bt_delta,
                    'jjpr_pts': jjpr_pts,
                })
            for entry in bt_gated_hist.get(uid, []):
                tid = entry[0]
                if tid in seen_tids: continue
                tsum = tournament_summary.get(tid)
                if tsum is None: continue
                place = placements_per_t.get(tid, {}).get(uid)
                jjpr_pts = 0.0
                for jc in jjpr_contribs.get(uid, []):
                    if jc['t_id'] == tid:
                        jjpr_pts = jc['points']
                        break
                si = t_seed_info.get(tid, {}).get(uid)
                tournament_entries.append({
                    'event_id': tsum.get('event_id'),
                    'date': tsum['date'],
                    'name': tsum['name'],
                    'event': tsum['event'],
                    'nent': tsum['nent'],
                    'place': place,
                    'seed': si['seed'] if si else None,
                    'spr': si['spr'] if si else None,
                    'is_weekend': tsum['is_weekend'],
                    'is_weekend_real': tsum.get('is_weekend_real', tsum['is_weekend']),
                    'is_smapa': tsum['is_smapa'],
                    'is_pre': tsum.get('is_pre', False),
                    'tjpr_lv': 0,
                    'tjpr_raw': 0.0,
                    'tjpr_age': 1.0,
                    'tjpr_pos': 0.0,
                    'tjpr_w': 0.0,
                    'tjpr_counted': False,
                    'bt_used': bt_used.get(uid, {}).get(tid, False),
                    'bt_d': entry[2],
                    'jjpr_pts': jjpr_pts,
                })
            tournament_entries.sort(key=lambda x: x['date'], reverse=True)
            display_cache[uid] = display

            # Per-tournament accumulator (= per_tournament_data[tid][uid])
            for c in tjpr_contribs.get(uid, []):
                tid = c['t_id']
                tsum = tournament_summary.get(tid)
                if tsum is None: continue
                place = placements_per_t.get(tid, {}).get(uid)
                si = t_seed_info.get(tid, {}).get(uid)
                bt_delta = 0.0; bt_used_flag = False
                for entry in bt_gated_hist.get(uid, []):
                    if entry[0] == tid:
                        bt_delta = entry[2]
                        bt_used_flag = bt_used.get(uid, {}).get(tid, False)
                        break
                per_tournament_data[tid][uid] = {
                    'user_id': uid, 'display': display, 'place': place,
                    'seed': si['seed'] if si else None,
                    'spr': si['spr'] if si else None,
                    'global_ranks': {'ensemble': ens_rank, 'tjpr': tj_rank, 'bt_gated': bt_rank},
                    'tjpr_w': c['weighted'], 'tjpr_raw': c['raw_points'],
                    'tjpr_lv': tj_level, 'tjpr_counted': (c['rank_in_player'] < LV2_PARAMS[2]) if tj_level >= 2 else (c['rank_in_player'] < LV1_PARAMS[2]),
                    'bt_d': bt_delta, 'bt_used': bt_used_flag,
                }
            for entry in bt_gated_hist.get(uid, []):
                tid = entry[0]
                if tid in per_tournament_data and uid in per_tournament_data[tid]: continue
                tsum = tournament_summary.get(tid)
                if tsum is None: continue
                place = placements_per_t.get(tid, {}).get(uid)
                si = t_seed_info.get(tid, {}).get(uid)
                per_tournament_data[tid][uid] = {
                    'user_id': uid, 'display': display, 'place': place,
                    'seed': si['seed'] if si else None,
                    'spr': si['spr'] if si else None,
                    'global_ranks': {'ensemble': ens_rank, 'tjpr': tj_rank, 'bt_gated': bt_rank},
                    'tjpr_w': 0.0, 'tjpr_raw': 0.0, 'tjpr_lv': 0, 'tjpr_counted': False,
                    'bt_d': entry[2], 'bt_used': bt_used.get(uid, {}).get(tid, False),
                }

            # History (sparse): list of {d, ranks + elo at that snapshot}
            history = []
            for days in SNAPSHOT_DAYS:
                if days not in snapshots:
                    continue
                sd = snapshots[days]
                # Only record if player has any data at that snapshot
                if uid in sd['ensemble_ranks'] or uid in sd['tjpr_ranks'] or uid in sd['bt_gated_ranks']:
                    history.append({
                        'd': days,
                        'ens': sd['ensemble_ranks'].get(uid),
                        'tjpr_r': sd['tjpr_ranks'].get(uid),
                        'tjpr_lv': sd.get('tjpr_levels', {}).get(uid),
                        'bt_g_r': sd['bt_gated_ranks'].get(uid),
                        'jjpr_r': sd['jjpr_ranks'].get(uid),
                        'tjpr_s': sd['tjpr_scores'].get(uid),
                        'tjpr_e': sd['tjpr_elo'].get(uid),
                        'bt_g_e': sd['bt_gated_elo'].get(uid),
                        'bt_f_e': sd['bt_flat_elo'].get(uid),
                        'jjpr_s': sd['jjpr_scores'].get(uid),
                    })

            # Lightweight main record (for the main ranking table)
            main_rec = {
                'user_id': uid,
                'display': display,
                'ranks': {
                    'ensemble': ens_rank,
                    'tjpr': tj_rank,
                    'bt_gated': bt_rank,
                    'bt_flat': bt_all_ranks.get(uid, 0),
                    'jjpr_v3': jj_rank,
                },
                'scores': {
                    'tjpr_score': tj_score,
                    'tjpr_elo': tj_elo,
                    'tjpr_level': tj_level,
                    'bt_gated_ordinal': bt_ord,
                    'bt_gated_elo': bt_elo,
                    'bt_all_ordinal': bt_all_ord.get(uid, 0.0),
                    'bt_all_elo': norm_bt_disp.get(uid, 0.0),
                    'jjpr_score': jj_score,
                    'ensemble_avg_rank': ensemble_avg_rank.get(uid),
                    'ensemble_avg_score': ensemble_avg_score.get(uid),
                },
                'metadata': {
                    'tour_count_3y': tc,
                    'bt_weekday_included': tc <= GATED_M_TOUR,
                    'matches_count_3y': player_match_count.get(uid, 0),
                },
            }
            fp.write(json.dumps(main_rec, ensure_ascii=False) + '\n')

            # Derived highlights for player detail page
            def _slim(e):
                return {
                    'event_id': e.get('event_id'),
                    'date': e['date'], 'name': e['name'], 'event': e['event'],
                    'place': e['place'], 'nent': e['nent'],
                    'seed': e.get('seed'), 'spr': e.get('spr'),
                    'tjpr_w': e.get('tjpr_w'), 'tjpr_raw': e.get('tjpr_raw'),
                    'tjpr_lv': e.get('tjpr_lv'), 'tjpr_counted': e.get('tjpr_counted'),
                    'bt_d': e.get('bt_d'), 'bt_used': e.get('bt_used'),
                }
            # 実績: 集計対象 (=ランキングに寄与した) 大会だけを採用
            # tjpr_w > 0 → その大会は順位評価に寄与した (filter を通った)
            # bt_used → その大会のいずれかの試合で BT rating が更新された (直対評価に寄与)
            # SPR の Top: 到達 Lv の filter を通る大会のみ
            def _passes_level(level, nent, is_wk):
                if level is None or level <= 0: return False
                if level >= 5: return (nent or 0) > 48 and is_wk
                if level == 4: return (nent or 0) > 24 and is_wk
                if level == 3: return (nent or 0) > 24
                return True  # Lv1/2: フィルタなし
            # 1 年以内 (top_bt_gains / top_spr 用): 直近の活動を強調するため
            one_year_ago = (eval_date - dt.timedelta(days=365)).date().isoformat()
            counted_tjpr = [e for e in tournament_entries if (e.get('tjpr_w') or 0) > 0]
            top_tjpr_contribs = [_slim(e) for e in sorted(counted_tjpr,
                                  key=lambda x: -x['tjpr_w'])[:5]]
            # 直対評価が伸びた試合 TOP 5 (per-match): 1 年以内に勝った試合のうち、BT delta が大きい順
            #   各エントリ: { opp_uid, opp_display, event_id, tournament_name, date, bt_d }
            match_list = match_wins.get(uid, [])
            scored_matches = []
            for tid_m, opp_uid_m, dlt_m in match_list:
                tsum_m = tournament_summary.get(tid_m)
                if not tsum_m: continue
                if (tsum_m.get('date') or '') < one_year_ago: continue
                scored_matches.append((dlt_m, tid_m, opp_uid_m, tsum_m))
            scored_matches.sort(key=lambda x: -x[0])
            top_bt_gains = []
            for dlt_m, tid_m, opp_uid_m, tsum_m in scored_matches[:5]:
                top_bt_gains.append({
                    'opp_uid': opp_uid_m,
                    'opp_display': format_display(users.get(opp_uid_m), opp_uid_m),
                    'event_id': tsum_m.get('event_id'),
                    'tournament_name': tsum_m.get('name', ''),
                    'event_name': tsum_m.get('event', ''),
                    'date': tsum_m.get('date'),
                    'bt_d': dlt_m,
                })
            counted_spr = [e for e in tournament_entries
                           if e.get('spr') is not None and e['spr'] > 0
                           and e.get('date', '') >= one_year_ago
                           and _passes_level(tj_level, e.get('nent'), e.get('is_weekend'))]
            top_spr = [_slim(e) for e in sorted(counted_spr, key=lambda x: -x['spr'])[:5]]
            recent_spr = [_slim(e) for e in tournament_entries[:10] if e.get('spr') is not None]
            # Peak ranks across history + current
            def _peak(key_hist, current):
                best_rank = current; best_label = 'now'
                for h in history:
                    v = h.get(key_hist)
                    if v is None: continue
                    if best_rank is None or v < best_rank:
                        best_rank = v; best_label = f"{h['d']}日前"
                return {'rank': best_rank, 'when': best_label}
            peak_ranks = {
                'ensemble':  _peak('ens',    ens_rank),
                'tjpr':      _peak('tjpr_r', tj_rank),
                'bt_gated':  _peak('bt_g_r', bt_rank),
            }
            # Achievements (リッチオブジェクト、priority 順)
            # 静的アチーブメント: 大会実績より十分高い (大会 max ≈ nent*10 + 10000、nent=3000 で 40000)
            # 「一度でも到達したら剥奪されない」原則: ピーク値を採用。2024-01-01 以降の範囲のみ。
            ach = []
            since_2024 = dt.date(2024, 1, 1)
            best_ens = ens_rank if ens_rank else None
            best_lv = tj_level
            for h in history:
                snap_dt = (eval_date - dt.timedelta(days=h['d'])).date()
                if snap_dt < since_2024: continue
                if h.get('ens') and (best_ens is None or h['ens'] < best_ens):
                    best_ens = h['ens']
                if h.get('tjpr_lv') and h['tjpr_lv'] > best_lv:
                    best_lv = h['tjpr_lv']
            # Best Top N (single tier — highest only)
            if best_ens:
                if best_ens <= 1:
                    ach.append({'label': '👑 最高 全国 1 位', 'cls': 'gold', 'priority': 200000})
                elif best_ens <= 10:
                    ach.append({'label': '🌟 最高 Top 10', 'cls': 'gold', 'priority': 150000})
                elif best_ens <= 50:
                    ach.append({'label': '🔥 最高 Top 50', 'cls': 'silver', 'priority': 130000})
                elif best_ens <= 100:
                    ach.append({'label': '💪 最高 Top 100', 'cls': 'bronze', 'priority': 110000})
                elif best_ens <= 500:
                    ach.append({'label': '🎯 最高 Top 500', 'cls': 'blue', 'priority': 70000})
                elif best_ens <= 1000:
                    ach.append({'label': '🎯 最高 Top 1000', 'cls': '', 'priority': 60000})
            # Best Lv (single tier — highest only)
            if best_lv >= 5:
                ach.append({'label': '🥇 最高 Lv5 到達', 'cls': 'gold', 'priority': 140000})
            elif best_lv == 4:
                ach.append({'label': '🥈 最高 Lv4 到達', 'cls': 'silver', 'priority': 100000})
            elif best_lv == 3:
                ach.append({'label': '🥉 最高 Lv3 到達', 'cls': 'bronze', 'priority': 80000})
            elif best_lv == 2:
                ach.append({'label': '🎖 最高 Lv2 到達', 'cls': '', 'priority': 65000})
            # 1ヶ月で +N ランク climb (現状の動的バッチ — 過去の climb は対象外)
            h30 = next((h for h in history if h.get('d') == 30), None)
            if h30 and h30.get('ens') and ens_rank:
                climb = h30['ens'] - ens_rank
                if climb >= 100:
                    ach.append({'label': f'🚀 1ヶ月で +{climb} ランク', 'cls': 'green', 'priority': 95000 + climb})

            # ── UF (Upset Factor): 単独最高値で 1 個 ──
            muf_ach = player_max_uf_ach.get(uid)
            if muf_ach and muf_ach.get('uf', 0) >= 5:
                uf_v = muf_ach['uf']
                uf_cls = 'gold' if uf_v >= 10 else 'silver' if uf_v >= 8 else 'bronze' if uf_v >= 6 else 'blue'
                ach.append({'label': f'⚡ UF {uf_v} 達成', 'cls': uf_cls, 'priority': 50000 + uf_v * 500})
            # ── SPR (Seed Performance Rating): 単独最高値で 1 個 ──
            msp_ach = player_max_spr_ach.get(uid)
            if msp_ach and msp_ach.get('spr', 0) >= 5:
                spr_v = msp_ach['spr']
                spr_cls = 'gold' if spr_v >= 10 else 'silver' if spr_v >= 8 else 'bronze' if spr_v >= 6 else 'blue'
                ach.append({'label': f'✨ SPR {spr_v} 達成', 'cls': spr_cls, 'priority': 48000 + spr_v * 500})
            # ── 活動量バッチ: 全て 2024+ 累計、最高ティアのみ ──
            def _add_tier(value, tiers, base_priority):
                """tiers = [(threshold, label, cls), ...] 高い閾値順。最高ティア 1 つだけ append."""
                for thr, lbl, c in tiers:
                    if value >= thr:
                        ach.append({'label': lbl, 'cls': c, 'priority': base_priority + thr})
                        return
            tc_2024 = player_tour_count_2024.get(uid, 0)
            _add_tier(tc_2024, [
                (500, '🏆 大会出場 500+', 'gold'),
                (300, '🎖️ 大会出場 300+', 'silver'),
                (100, '🏅 大会出場 100+', 'bronze'),
                (50,  '🎫 大会出場 50+', 'blue'),
                (20,  '🎟️ 大会出場 20+', ''),
            ], base_priority=40000)
            mc_2024 = player_match_count_2024.get(uid, 0)
            _add_tier(mc_2024, [
                (5000, '⚔ 試合数 5000+', 'gold'),
                (3000, '⚔ 試合数 3000+', 'silver'),
                (1000, '⚔ 試合数 1000+', 'bronze'),
                (500,  '⚔ 試合数 500+', 'blue'),
                (200,  '⚔ 試合数 200+', ''),
            ], base_priority=35000)
            wc_2024 = player_win_count_2024.get(uid, 0)
            _add_tier(wc_2024, [
                (3000, '🏅 勝利数 3000+', 'gold'),
                (1500, '🏅 勝利数 1500+', 'silver'),
                (500,  '🏅 勝利数 500+', 'bronze'),
                (200,  '🏅 勝利数 200+', 'blue'),
                (100,  '🏅 勝利数 100+', ''),
            ], base_priority=30000)
            opp_counts = player_vs_opp_count.get(uid, {})
            if opp_counts:
                max_vs = max(opp_counts.values())
                _add_tier(max_vs, [
                    (50, '🤝 同一相手と対戦 50+', 'gold'),
                    (30, '🤝 同一相手と対戦 30+', 'silver'),
                    (20, '🤝 同一相手と対戦 20+', 'bronze'),
                    (10, '🤝 同一相手と対戦 10+', 'blue'),
                    (5,  '🤝 同一相手と対戦 5+', ''),
                ], base_priority=25000)

            # 大会別アチーブメント: series ごとに最高位だけ採用、count があれば xN
            tier_priority_base = {'優勝': 10000, '準優勝': 5000, '3位': 3000, '4位': 2000, '5位': 1500, 'Top 8': 1000}
            tier_icon = {'優勝': '🏆', '準優勝': '🥈', '3位': '🥉', '4位': '🎖', '5位': '🎖', 'Top 8': '🏅'}
            tier_cls = {'優勝': 'gold', '準優勝': 'silver', '3位': 'bronze', '4位': 'bronze', '5位': '', 'Top 8': ''}
            series_buckets = defaultdict(lambda: defaultdict(list))  # series -> bucket -> entries
            for e in tournament_entries:
                place = e.get('place')
                if place is None or place < 1: continue
                nent = e.get('nent') or 0
                is_wk_e = e.get('is_weekend')
                # 3-8位: 大きい大会 + プレイヤーの集計対象 (tjpr_w > 0)
                if place > 2:
                    if (e.get('tjpr_w') or 0) <= 0: continue
                    if nent <= 48: continue
                    if not is_wk_e: continue
                s = tournament_series(e.get('name'))
                if not s: continue
                if place == 1: b = '優勝'
                elif place == 2: b = '準優勝'
                elif place == 3: b = '3位'
                elif place == 4: b = '4位'
                elif place == 5: b = '5位'
                elif 6 <= place <= 8: b = 'Top 8'
                else: continue
                series_buckets[s][b].append(e)
            for s, buckets in series_buckets.items():
                # Best bucket per series
                for bucket_name in ['優勝', '準優勝', '3位', '4位', '5位', 'Top 8']:
                    if bucket_name not in buckets: continue
                    entries = buckets[bucket_name]
                    count = len(entries)
                    suffix = f' ×{count}' if count > 1 else ''
                    max_nent = max(int(en.get('nent') or 0) for en in entries)
                    # nent 主導でソート: 大きい大会 Top 8 > 小さい大会 優勝 になることもある。
                    # tier_priority は tiebreaker (同 nent なら 優勝 > 準優勝)。
                    priority = max_nent * 10 + tier_priority_base[bucket_name] + (count - 1) * 50
                    ach.append({
                        'label': f"{tier_icon[bucket_name]} {s} {bucket_name}{suffix}",
                        'cls': tier_cls[bucket_name],
                        'priority': priority,
                    })
                    break
            ach.sort(key=lambda x: -x['priority'])
            # Max UF (with opponent display resolved)
            muf = player_max_uf.get(uid)
            max_uf_rec = None
            if muf is not None:
                opp_disp = format_display(users.get(muf['opp_uid']), muf['opp_uid'])
                max_uf_rec = {**muf, 'opp_display': opp_disp}
            # Per-player detail JSON (main fields embedded so player page doesn't need to fetch the 7MB JSONL)
            detail_rec = {
                'user_id': uid,
                'display': display,
                'ranks': main_rec['ranks'],
                'scores': main_rec['scores'],
                'metadata': main_rec['metadata'],
                'tjpr_lv_breakdown': tjpr_level_scores.get(uid, {}),
                'tournaments': tournament_entries[:60],
                'history': history,
                'top_tjpr_contribs': top_tjpr_contribs,
                'top_bt_gains': top_bt_gains,
                'top_spr': top_spr,
                'recent_spr': recent_spr,
                'peak_ranks': peak_ranks,
                'max_uf': max_uf_rec,
                'achievements': ach,
            }
            detail_path = players_dir / f"{uid}.json"
            detail_path.write_text(json.dumps(detail_rec, ensure_ascii=False))
            written += 1

    print(f"  Wrote {written} players: main JSONL to {out_path}, details to {players_dir}/", flush=True)

    # ── Per-tournament JSON output ──
    print("Building per-tournament JSON files ...", flush=True)
    n_tourns_written = 0
    for t in all_tournaments:
        tid = id(t)
        meta_t = t_meta_by_id[tid]
        eid = meta_t.get('event_id')
        if eid is None: continue  # skip if no event_id
        placements = placements_per_t.get(tid, {})
        if not placements: continue
        # Build standings: include all attendees (rated + unrated)
        seed_info_t = t_seed_info.get(tid, {})
        rated_data = per_tournament_data.get(tid, {})
        standings = []
        for uid_, place_ in placements.items():
            if place_ is None: continue
            r = rated_data.get(uid_)
            if r is not None:
                standings.append(r)
            else:
                # unrated attendee
                disp = display_cache.get(uid_) or format_display(users.get(uid_), uid_)
                si_ = seed_info_t.get(uid_)
                standings.append({
                    'user_id': uid_, 'display': disp, 'place': place_,
                    'seed': si_['seed'] if si_ else None,
                    'spr': si_['spr'] if si_ else None,
                    'global_ranks': {'ensemble': None, 'tjpr': None, 'bt_gated': None},
                    'tjpr_w': 0.0, 'tjpr_raw': 0.0, 'tjpr_lv': 0, 'tjpr_counted': False,
                    'bt_d': 0.0, 'bt_used': False,
                })
        standings.sort(key=lambda x: x.get('place') or 10**9)
        # Highlights
        def _top(field, n=5, want_positive=True):
            arr = [s for s in standings if s.get(field) is not None and (s.get(field) > 0 if want_positive else True)]
            arr.sort(key=lambda x: -x[field])
            return arr[:n]
        # Match-level upsets: winner_seed > loser_seed の試合を W2W gap (UF) で TOP 5
        seed_info_t = t_seed_info.get(tid, {})
        match_upsets = []
        for m in t.matches:
            sw_info = seed_info_t.get(m.winner_id)
            sl_info = seed_info_t.get(m.loser_id)
            if not sw_info or not sl_info: continue
            sw, sl = sw_info['seed'], sl_info['seed']
            if sw <= sl: continue
            uf = placement_to_w2w(sw) - placement_to_w2w(sl)
            if uf <= 0: continue
            match_upsets.append({
                'winner': {
                    'user_id': m.winner_id,
                    'display': display_cache.get(m.winner_id) or format_display(users.get(m.winner_id), m.winner_id),
                    'seed': sw, 'place': sw_info.get('place'),
                },
                'loser': {
                    'user_id': m.loser_id,
                    'display': display_cache.get(m.loser_id) or format_display(users.get(m.loser_id), m.loser_id),
                    'seed': sl, 'place': sl_info.get('place'),
                },
                'uf': uf,
            })
        match_upsets.sort(key=lambda x: -x['uf'])
        match_upsets = match_upsets[:5]
        highlights = {
            'top_match_upsets': match_upsets,
            'biggest_point_gains': _top('tjpr_raw'),
            'top_bt_gains': _top('bt_d'),
        }
        t_doc = {
            'event_id': eid,
            'name': meta_t.get('tname', ''),
            'event_name': meta_t.get('ename', ''),
            'date': meta_t.get('date'),
            'end_date': meta_t.get('end_date'),
            'nent': meta_t.get('nent'),
            'is_weekend': meta_t.get('is_weekend'),
            'is_weekend_real': meta_t.get('is_weekend_real', meta_t.get('is_weekend')),
            'is_smapa': meta_t.get('is_smapa'),
            'is_pre': meta_t.get('is_pre', False),
            'standings': standings,
            'highlights': highlights,
        }
        (tournaments_dir / f"{eid}.json").write_text(json.dumps(t_doc, ensure_ascii=False))
        n_tourns_written += 1
    print(f"  Wrote {n_tourns_written} tournaments to {tournaments_dir}/", flush=True)

    meta = {
        'eval_date': eval_date.date().isoformat(),
        'generated_at': dt.datetime.now().isoformat(),
        'computation_time_s': round(time.time() - t0, 1),
        'n_tournaments_total': len(all_tournaments),
        'n_players': written,
        'lookback_days': LOOKBACK_DAYS,
        'jjpr_lookback_days': JJPR_LOOKBACK_DAYS,
        'snapshot_days': SNAPSHOT_DAYS,
        'params': {
            'TJPR_LV1': {'base': LV1_PARAMS[0], 'floor': LV1_PARAMS[1], 'topN': LV1_PARAMS[2], 'pos_decay': LV1_PARAMS[3]},
            'TJPR_LV2': {'base': LV2_PARAMS[0], 'floor': LV2_PARAMS[1], 'topN': LV2_PARAMS[2], 'pos_decay': LV2_PARAMS[3]},
            'LV3_FILTER': LV3_FILTER,
            'LV4_FILTER': LV4_FILTER,
            'LV5_FILTER': LV5_FILTER,
            'TJPR_DEFAULT_RATE': TJPR_DEFAULT_RATE,
            'OSK_BETA': OSK_BETA,
            'ELO_PER_UNIT': round(ELO_PER_UNIT, 4),
            'GATED_M_TOUR': GATED_M_TOUR,
            'JJPR_TOP_K': JJPR_TOP_K,
            'TJPR_ELO_SCALE': TJPR_ELO_SCALE,
            'TJPR_ELO_OFFSET': TJPR_ELO_OFFSET,
            'BT_ELO_OFFSET': BT_ELO_OFFSET,
            'TJPR_MAX_SCORE': max_tjpr,
        },
    }
    Path(args.meta_out).write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"  Wrote meta to {args.meta_out}", flush=True)
    print(f"DONE in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
