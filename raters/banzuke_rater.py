"""Virtual DE bracket rater with real rating backend.

Simulates actual rating updates (win AND loss) through a virtual DE losers
bracket, using the player's real current rating and virtual opponents
constructed from the average stats of actual bracket participants.

Three backends: elo, glicko2, openskill_bt.
"""
from __future__ import annotations

import statistics

from glicko2 import Player
from openskill.models import BradleyTerryFull

from .base import Rater
from smash_banzuke import build_de_losers_round_participants
from jjpr_v3 import placement_to_tier


class BanzukeRater(Rater):
    """Virtual DE bracket rater with real rating backend."""

    trains_on = "standings"

    def __init__(self, backend: str = "elo", elo_k: float = 32.0, include_loss: bool = True):
        self.backend = backend
        self.include_loss = include_loss
        suffix = "" if include_loss else "_noL"
        self.name = f"BanzukeRate_{backend}{suffix}"
        self.elo_k = elo_k

        if backend == "elo":
            self.ratings: dict[int, float] = {}
            self._initial = 1500.0
        elif backend == "glicko2":
            self.ratings: dict[int, Player] = {}
            self._initial_r = 1500.0
            self._initial_rd = 350.0
            self._initial_vol = 0.06
        elif backend == "openskill_bt":
            self._model = BradleyTerryFull()
            self.ratings: dict[int, object] = {}
        else:
            raise ValueError(f"Unknown backend: {backend}")

    # ------------------------------------------------------------------
    # Player bookkeeping
    # ------------------------------------------------------------------

    def _ensure(self, uid: int) -> None:
        """Ensure player exists in ratings."""
        if uid not in self.ratings:
            if self.backend == "elo":
                self.ratings[uid] = self._initial
            elif self.backend == "glicko2":
                self.ratings[uid] = Player(
                    rating=self._initial_r,
                    rd=self._initial_rd,
                    vol=self._initial_vol,
                )
            elif self.backend == "openskill_bt":
                self.ratings[uid] = self._model.rating()

    def rating(self, player: int) -> float:
        self._ensure(player)
        if self.backend == "elo":
            return self.ratings[player]
        elif self.backend == "glicko2":
            return self.ratings[player].rating
        elif self.backend == "openskill_bt":
            return self.ratings[player].ordinal()
        raise ValueError(f"Unknown backend: {self.backend}")  # unreachable

    def has_player(self, player: int) -> bool:
        return player in self.ratings

    def predict(self, p1: int, p2: int) -> float:
        r1, r2 = self.rating(p1), self.rating(p2)
        return 1.0 / (1.0 + 10 ** ((r2 - r1) / 400.0))

    # ------------------------------------------------------------------
    # Match / tournament interface
    # ------------------------------------------------------------------

    def update_match(self, winner: int, loser: int, timestamp: int | None = None) -> None:
        # Not used directly — this rater processes full tournaments.
        pass

    def update_tournament(
        self,
        standings: list[tuple[int, int]],
        matches: list,
        timestamp: int | None = None,
    ) -> None:
        # 1. Collect unique participants and snapshot current ratings.
        seen: set[int] = set()
        participants: list[tuple[int, float]] = []  # (uid, rating_snapshot)
        for _, uid in standings:
            if uid in seen:
                continue
            seen.add(uid)
            self._ensure(uid)
            participants.append((uid, self.rating(uid)))

        n = len(participants)
        if n < 2:
            return

        # 2. Sort by rating ascending (weakest = seed 0).
        participants.sort(key=lambda x: x[1])

        # 3. Build virtual DE losers bracket rounds.
        lr_rounds = build_de_losers_round_participants(n)
        total_lr = len(lr_rounds)
        if total_lr == 0:
            return

        # 4. Compute virtual opponent for each round.
        round_opps: list[dict] = []
        for seeds_in_round in lr_rounds:
            valid_seeds = [s for s in seeds_in_round if s < n]
            round_opps.append(self._make_virtual_opponent(valid_seeds, participants))

        # 5. For each player, compute rounds won and apply rating updates.
        max_tier_n = placement_to_tier(n)
        seen2: set[int] = set()
        for place, uid in standings:
            if uid in seen2:
                continue
            seen2.add(uid)

            tier = placement_to_tier(place)
            rounds_won = min(max(0, max_tier_n - tier), total_lr)

            win_opps = [round_opps[r] for r in range(rounds_won)]
            loss_opp = round_opps[rounds_won] if (self.include_loss and rounds_won < total_lr) else None

            self._apply_matches(uid, win_opps, loss_opp)

    # ------------------------------------------------------------------
    # Virtual opponent construction
    # ------------------------------------------------------------------

    def _make_virtual_opponent(
        self,
        seed_indices: list[int],
        participants: list[tuple[int, float]],
    ) -> dict:
        """Create a virtual opponent from the average stats of round participants."""
        if self.backend == "elo":
            if not seed_indices:
                return {"rating": self._initial}
            ratings = [participants[s][1] for s in seed_indices]
            return {"rating": statistics.mean(ratings)}

        elif self.backend == "glicko2":
            if not seed_indices:
                return {"rating": self._initial_r, "rd": self._initial_rd}
            ratings_val: list[float] = []
            rds: list[float] = []
            for s in seed_indices:
                uid = participants[s][0]
                ratings_val.append(participants[s][1])
                if uid in self.ratings:
                    rds.append(self.ratings[uid].rd)
                else:
                    rds.append(self._initial_rd)
            return {
                "rating": statistics.mean(ratings_val),
                "rd": statistics.mean(rds),
            }

        elif self.backend == "openskill_bt":
            if not seed_indices:
                default = self._model.rating()
                return {"mu": float(default.mu), "sigma": float(default.sigma)}
            mus: list[float] = []
            sigmas: list[float] = []
            for s in seed_indices:
                uid = participants[s][0]
                if uid in self.ratings:
                    mus.append(float(self.ratings[uid].mu))
                    sigmas.append(float(self.ratings[uid].sigma))
                else:
                    default = self._model.rating()
                    mus.append(float(default.mu))
                    sigmas.append(float(default.sigma))
            return {
                "mu": statistics.mean(mus),
                "sigma": statistics.mean(sigmas),
            }

        raise ValueError(f"Unknown backend: {self.backend}")  # unreachable

    # ------------------------------------------------------------------
    # Rating update application
    # ------------------------------------------------------------------

    def _apply_matches(
        self,
        uid: int,
        win_opps: list[dict],
        loss_opp: dict | None,
    ) -> None:
        """Apply virtual match results to the player's rating."""
        if self.backend == "elo":
            r = self.ratings[uid]
            for opp in win_opps:
                exp = 1.0 / (1.0 + 10 ** ((opp["rating"] - r) / 400.0))
                r += self.elo_k * (1.0 - exp)
            if loss_opp is not None:
                exp = 1.0 / (1.0 + 10 ** ((loss_opp["rating"] - r) / 400.0))
                r += self.elo_k * (0.0 - exp)
            self.ratings[uid] = r

        elif self.backend == "glicko2":
            p = self.ratings[uid]
            opp_ratings = [o["rating"] for o in win_opps]
            opp_rds = [o["rd"] for o in win_opps]
            outcomes = [1] * len(win_opps)
            if loss_opp is not None:
                opp_ratings.append(loss_opp["rating"])
                opp_rds.append(loss_opp["rd"])
                outcomes.append(0)
            if opp_ratings:
                opp_rds = [max(rd, 30.0) for rd in opp_rds]
                try:
                    p.update_player(opp_ratings, opp_rds, outcomes)
                except (ZeroDivisionError, OverflowError, ValueError):
                    pass

        elif self.backend == "openskill_bt":
            for opp in win_opps:
                virt = self._model.rating(mu=opp["mu"], sigma=opp["sigma"])
                new = self._model.rate(
                    [[self.ratings[uid]], [virt]], ranks=[1, 2],
                )
                self.ratings[uid] = new[0][0]
            if loss_opp is not None:
                virt = self._model.rating(
                    mu=loss_opp["mu"], sigma=loss_opp["sigma"],
                )
                new = self._model.rate(
                    [[self.ratings[uid]], [virt]], ranks=[2, 1],
                )
                self.ratings[uid] = new[0][0]
