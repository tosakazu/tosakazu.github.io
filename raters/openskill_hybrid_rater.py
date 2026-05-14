"""
Hybrid OpenSkill rater: trains on BOTH tournament standings AND matches,
using a single PlackettLuce rating state.

Design
------
- A PlackettLuce call with 2 teams (1 player each) is mathematically
  equivalent to a BradleyTerry update. So we use a single PL model for
  both signal types and just vary the inputs.
- Weighting "standings vs matches" is implemented as a continuous
  blend. For an update with weight ``w`` we apply ``floor(w)`` full
  updates plus one fractional blend update with ``alpha = w - floor(w)``.

  A fractional blend is:

      mu_blend    = mu_old    + alpha * (mu_new    - mu_old)
      sigma_blend = sigma_old + alpha * (sigma_new - sigma_old)

  Full updates are proper Bayesian updates (sigma shrinks with each
  application), so ``w=3`` means "treat this observation as three
  independent observations". ``w=2.5`` means "two independent + half".

- The domain invariant **bracket-standing importance > match importance**
  is enforced at construction time: ``match_weight`` must be strictly
  less than ``pl_weight``. Both must be > 0 and < 100 (safety cap).

Notes
-----
- Players not present in standings still get rated via match updates.
- Standings dedupe by user_id (first occurrence wins).
- A PL update on a single tournament is still O(N) rate() calls internally
  (inside openskill), so cost scales with tournament size, not with weight.
"""
from openskill.models import PlackettLuce

from .base import Rater


class OpenSkillHybridRater(Rater):
    name = "OpenSkill(PL+BT)"
    trains_on = "hybrid"

    def __init__(self, pl_weight: float = 1.0, match_weight: float = 0.1, max_weight: float = 100.0):
        pl_weight = float(pl_weight)
        match_weight = float(match_weight)
        if not (0.0 < match_weight < pl_weight):
            raise ValueError(
                f"Require 0 < match_weight ({match_weight}) "
                f"< pl_weight ({pl_weight}) so that "
                f"bracket-standing importance > match importance."
            )
        if pl_weight > max_weight:
            raise ValueError(f"pl_weight ({pl_weight}) exceeds safety cap {max_weight}")
        self.model = PlackettLuce()
        self.pl_weight = pl_weight
        self.match_weight = match_weight
        self.ratings: dict[int, object] = {}
        self.name = f"OpenSkill(PL={pl_weight:g},BT={match_weight:g})"

    def _get(self, p: int):
        if p not in self.ratings:
            self.ratings[p] = self.model.rating()
        return self.ratings[p]

    def _blend_one(self, old, new, alpha: float):
        """Return a new Rating object linearly interpolated between old and new."""
        if alpha <= 0.0:
            return old
        if alpha >= 1.0:
            return new
        new_mu = old.mu + alpha * (new.mu - old.mu)
        new_sigma = old.sigma + alpha * (new.sigma - old.sigma)
        if new_sigma < 1e-6:
            new_sigma = 1e-6
        return self.model.rating(mu=new_mu, sigma=new_sigma)

    def _apply_pl_once(self, standings):
        """Run one full PL update (weight=1.0) on the full standings ranking.

        Returns (uids_order, pre_ratings, post_ratings) so callers can blend.
        """
        seen = set()
        pre = []
        teams = []
        ranks = []
        uids = []
        for place, uid in standings:
            if uid in seen:
                continue
            seen.add(uid)
            cur = self._get(uid)
            pre.append(cur)
            teams.append([cur])
            ranks.append(place)
            uids.append(uid)
        if len(teams) < 2:
            return None
        new_teams = self.model.rate(teams, ranks=ranks)
        post = [t[0] for t in new_teams]
        return uids, pre, post

    def _apply_pl_update(self, standings):
        """Apply PL standings update with weight self.pl_weight.

        Weight is decomposed as: floor(w) full independent updates plus one
        fractional blend update with alpha = w - floor(w).
        """
        w = self.pl_weight
        if w <= 0:
            return
        full_iters = int(w)
        frac = w - full_iters
        for _ in range(full_iters):
            result = self._apply_pl_once(standings)
            if result is None:
                return
            uids, _pre, post = result
            for uid, new in zip(uids, post):
                self.ratings[uid] = new
        if frac > 0:
            result = self._apply_pl_once(standings)
            if result is None:
                return
            uids, pre, post = result
            for uid, old, new in zip(uids, pre, post):
                self.ratings[uid] = self._blend_one(old, new, frac)

    def _apply_match_once(self, winner: int, loser: int):
        """Run one full BT/PL-2-team update; return (pre_w, pre_l, post_w, post_l)."""
        w_old = self._get(winner)
        l_old = self._get(loser)
        new_ratings = self.model.rate([[w_old], [l_old]], ranks=[1, 2])
        return w_old, l_old, new_ratings[0][0], new_ratings[1][0]

    def _apply_match_update(self, winner: int, loser: int):
        """Apply match update with weight self.match_weight (floor + frac blend)."""
        w = self.match_weight
        if w <= 0:
            return
        full_iters = int(w)
        frac = w - full_iters
        for _ in range(full_iters):
            _, _, post_w, post_l = self._apply_match_once(winner, loser)
            self.ratings[winner] = post_w
            self.ratings[loser] = post_l
        if frac > 0:
            pre_w, pre_l, post_w, post_l = self._apply_match_once(winner, loser)
            self.ratings[winner] = self._blend_one(pre_w, post_w, frac)
            self.ratings[loser] = self._blend_one(pre_l, post_l, frac)

    def update_tournament(self, standings, matches, timestamp=None):
        if standings:
            self._apply_pl_update(standings)
        if matches:
            for m in matches:
                self._apply_match_update(m.winner_id, m.loser_id)

    def update_match(self, winner: int, loser: int, timestamp=None) -> None:
        self._apply_match_update(winner, loser)

    def predict(self, p1: int, p2: int) -> float:
        r1 = self._get(p1)
        r2 = self._get(p2)
        probs = self.model.predict_win([[r1], [r2]])
        return float(probs[0])

    def rating(self, player: int) -> float:
        return self._get(player).ordinal()

    def has_player(self, player: int) -> bool:
        return player in self.ratings
