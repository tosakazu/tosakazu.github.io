"""
OpenSkill PlackettLuce rater where tied standings are broken by
"tournament run difficulty" computed from the match graph.

Idea
----
Raw smash standings have heavy ties: 5/5, 7/7, 9/9/9/9, 13/13/13/13,
17x8, 25x8, ... These carry very little per-player information for
PL. We break the ties within each placement group using a per-player
"difficulty" score derived from the match-level graph:

    difficulty(P) := product over D in wins(P) of  P(x beats D) ^ 2

where ``x`` is a fixed reference skill (Rating(mu=ref_skill)) and
``D``'s skill is the rater's *current* mu for D (before this
tournament's update). The ``^2`` encodes "the winner took a 2-0
against D" (i.e. the reference player would have to beat D twice).
Lower difficulty  = harder run = better rank within the tie group.

Training: for each tournament we build a finely-ranked order
(placements primary, -log_difficulty secondary) and feed the whole
thing as one PlackettLuce.rate(...) call. No match-level updates
(match_weight is effectively 0).

Notes
-----
- Players with 0 tournament wins get log_difficulty = 0 (the identity
  of an empty product), which places them at the BOTTOM of their tie
  group. That's the right direction: they took the "easiest" run
  within that group.
- The reference skill ``x`` is expressed on the same mu scale as the
  underlying PlackettLuce model.
- We use openskill's ``predict_win`` to get P(x beats D) so that the
  sigma and beta scaling is consistent with the rater's own model.
"""
import math
from collections import defaultdict

from openskill.models import PlackettLuce

from .base import Rater


class OpenSkillPLTiebreakRater(Rater):
    name = "OpenSkill(PL,tiebreak)"
    trains_on = "standings+matches"

    def __init__(
        self,
        ref_skill: float | None = None,
        epochs: int = 1,
        pl_weight: float = 1.0,
        match_weight: float = 0.0,
        pl_log2_slope: float = 0.0,
        pl_log2_offset: float = 0.0,
        pl_weight_min: float = 0.1,
        pl_weight_max: float = 100.0,
    ):
        self.model = PlackettLuce()
        # Default x = the model's default mu (so P(x beats "average D") = 0.5)
        self.ref_skill = (
            float(ref_skill) if ref_skill is not None else float(self.model.mu)
        )
        self.epochs = int(epochs)
        self.pl_weight = float(pl_weight)
        self.match_weight = float(match_weight)
        # Size-dependent weighting: if pl_log2_slope != 0, the per-tournament
        # pl_weight is computed as:
        #     pl_weight(N) = clip(
        #         pl_log2_slope * log2(max(N, 2)) + pl_log2_offset,
        #         pl_weight_min,
        #         pl_weight_max,
        #     )
        # Otherwise the constant ``pl_weight`` is used.
        self.pl_log2_slope = float(pl_log2_slope)
        self.pl_log2_offset = float(pl_log2_offset)
        self.pl_weight_min = float(pl_weight_min)
        self.pl_weight_max = float(pl_weight_max)
        if self.pl_log2_slope == 0 and self.pl_weight <= 0:
            raise ValueError(f"pl_weight must be > 0, got {pl_weight}")
        if self.match_weight < 0:
            raise ValueError(f"match_weight must be >= 0, got {match_weight}")
        # Per-epoch bookkeeping so we can re-train across the full training set.
        self._train_buffer: list[tuple[list, list]] = []
        self.ratings: dict[int, object] = {}
        # Separate ratings snapshot used ONLY for difficulty computation.
        # On multi-epoch training, this holds the end-of-previous-pass state
        # so that each pass gets stronger "opponent strength" signals without
        # being contaminated by this pass's own in-progress updates.
        self._difficulty_ratings: dict[int, object] | None = None
        # Name reflects configuration
        parts = []
        if self.pl_log2_slope != 0:
            parts.append(f"pl={self.pl_log2_slope:g}·log₂N+{self.pl_log2_offset:g}")
        elif self.pl_weight != 1.0:
            parts.append(f"pl={self.pl_weight:g}")
        if self.match_weight > 0:
            parts.append(f"m={self.match_weight:g}")
        if epochs > 1:
            parts.append(f"ep={epochs}")
        suffix = f",{','.join(parts)}" if parts else ""
        self.name = f"OpenSkill(PL,tiebreak{suffix})"

    def _effective_pl_weight(self, n_entrants: int) -> float:
        """Return the pl_weight to use for a tournament of ``n_entrants`` size.

        If ``pl_log2_slope`` is set (nonzero), scales with log2 of the
        entrant count. Otherwise returns the constant ``self.pl_weight``.
        """
        if self.pl_log2_slope == 0:
            return self.pl_weight
        n = max(int(n_entrants), 2)
        w = self.pl_log2_slope * math.log2(n) + self.pl_log2_offset
        return max(self.pl_weight_min, min(self.pl_weight_max, w))

    def _get(self, p: int):
        if p not in self.ratings:
            self.ratings[p] = self.model.rating()
        return self.ratings[p]

    def _ref_rating(self):
        """Rating object representing a hypothetical player with skill ``x``."""
        return self.model.rating(mu=self.ref_skill)

    def _skill_rating_of(self, uid):
        """Return the rating used for difficulty computation for player ``uid``.

        When multi-epoch training is configured, after the first epoch we use
        the frozen ``_difficulty_ratings`` snapshot (the end of the previous
        epoch) so that difficulty assessments reflect "what we learned last
        pass" rather than the raw initial prior.
        """
        if self._difficulty_ratings is not None and uid in self._difficulty_ratings:
            return self._difficulty_ratings[uid]
        return self._get(uid)

    def _log_difficulty(self, beaten_ids, x_rating) -> float:
        """log( prod over D in beaten_ids of P(x beats D)^2 )."""
        if not beaten_ids:
            return 0.0
        total = 0.0
        for d in beaten_ids:
            d_rating = self._skill_rating_of(d)
            p = float(self.model.predict_win([[x_rating], [d_rating]])[0])
            p = max(1e-12, min(1.0 - 1e-12, p))
            total += 2.0 * math.log(p)
        return total

    def _build_fine_ranking(self, standings, matches):
        """
        Return ordered list of (uid, fine_rank) where:
          - primary order is the raw placement (small first)
          - secondary order (ties broken) is log_difficulty ascending
            (lower = harder run = better within the tie group)
          - fine_rank is a unique 1-based rank consistent with the order
        """
        # Build wins map from matches (who beat whom)
        wins = defaultdict(list)
        for m in matches:
            wins[m.winner_id].append(m.loser_id)

        x_rating = self._ref_rating()
        enriched = []
        seen = set()
        for place, uid in standings:
            if uid in seen:
                continue
            seen.add(uid)
            log_d = self._log_difficulty(wins.get(uid, []), x_rating)
            enriched.append((place, log_d, uid))

        # Primary: place ascending; secondary: log_d ascending (more negative = harder)
        enriched.sort(key=lambda x: (x[0], x[1]))
        return [(uid, rank) for rank, (_p, _d, uid) in enumerate(enriched, start=1)]

    def _blend_one(self, old, new, alpha: float):
        if alpha <= 0.0:
            return old
        if alpha >= 1.0:
            return new
        new_mu = old.mu + alpha * (new.mu - old.mu)
        new_sigma = old.sigma + alpha * (new.sigma - old.sigma)
        if new_sigma < 1e-6:
            new_sigma = 1e-6
        return self.model.rating(mu=new_mu, sigma=new_sigma)

    def _one_pl_pass(self, order):
        """Apply one full PL update against ``order`` (uid, fine_rank). Returns
        (pre_ratings, post_ratings) for optional blending by the caller."""
        uids = [u for u, _ in order]
        pre = [self._get(u) for u in uids]
        teams = [[r] for r in pre]
        ranks = [rank for _, rank in order]
        new_teams = self.model.rate(teams, ranks=ranks)
        post = [t[0] for t in new_teams]
        return uids, pre, post

    def _apply_match_once(self, winner: int, loser: int):
        w_old = self._get(winner)
        l_old = self._get(loser)
        new_ratings = self.model.rate([[w_old], [l_old]], ranks=[1, 2])
        return w_old, l_old, new_ratings[0][0], new_ratings[1][0]

    def _apply_match_update(self, winner: int, loser: int):
        """Apply per-match update, weighted by self.match_weight."""
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

    def _apply_tournament_update(self, standings, matches):
        """Tiebreak standings → fine ranking → PL update (pl_weight times),
        then per-match updates (match_weight each)."""
        order = self._build_fine_ranking(standings, matches)
        if len(order) >= 2:
            # Use effective pl_weight which may depend on tournament size
            n_entrants = len(order)
            w = self._effective_pl_weight(n_entrants)
            full_iters = int(w)
            frac = w - full_iters
            # Full Bayesian updates (sigma shrinks each time)
            for _ in range(full_iters):
                uids, _pre, post = self._one_pl_pass(order)
                for uid, new in zip(uids, post):
                    self.ratings[uid] = new
            # Fractional blend update (interpolated delta)
            if frac > 0:
                uids, pre, post = self._one_pl_pass(order)
                for uid, old, new in zip(uids, pre, post):
                    self.ratings[uid] = self._blend_one(old, new, frac)

        # Match updates (if configured)
        if self.match_weight > 0 and matches:
            for m in matches:
                self._apply_match_update(m.winner_id, m.loser_id)

    def update_tournament(self, standings, matches, timestamp=None):
        if self.epochs <= 1:
            self._apply_tournament_update(standings, matches)
        else:
            # Defer training: remember the inputs, refit over all buffered
            # tournaments in ``fit()``.
            self._train_buffer.append((list(standings), list(matches)))

    def fit(self):
        """Run multi-epoch refit over the buffered training tournaments.

        Epoch 1: difficulty uses the default prior (all D's at mu=ref).
        Epoch k>1: difficulty uses the ratings we ended epoch k-1 with,
        via the ``_difficulty_ratings`` snapshot. Active ratings are
        reset at the top of each epoch so the PL update sequence is
        replayed fresh from the prior.
        """
        if self.epochs <= 1 or not self._train_buffer:
            return
        for epoch_idx in range(self.epochs):
            if epoch_idx == 0:
                self._difficulty_ratings = None
            else:
                # Freeze the end-of-previous-pass ratings as the skill
                # reference for this pass's difficulty calculation.
                self._difficulty_ratings = dict(self.ratings)
            # Start this pass from the prior
            self.ratings = {}
            for standings, matches in self._train_buffer:
                self._apply_tournament_update(standings, matches)

    def update_match(self, winner: int, loser: int, timestamp=None) -> None:
        # Pure standings-based rater; matches are only used for tiebreaking
        # inside update_tournament, not as individual updates.
        pass

    def predict(self, p1: int, p2: int) -> float:
        r1 = self._get(p1)
        r2 = self._get(p2)
        probs = self.model.predict_win([[r1], [r2]])
        return float(probs[0])

    def rating(self, player: int) -> float:
        return self._get(player).ordinal()

    def has_player(self, player: int) -> bool:
        return player in self.ratings
