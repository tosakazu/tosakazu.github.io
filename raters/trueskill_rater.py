"""TrueSkill via Microsoft's `trueskill` library."""
import math

import trueskill

from .base import Rater


class TrueSkillRater(Rater):
    name = "TrueSkill"

    def __init__(self, draw_probability: float = 0.0):
        self.env = trueskill.TrueSkill(draw_probability=draw_probability)
        self.ratings: dict[int, trueskill.Rating] = {}

    def _get(self, p: int) -> trueskill.Rating:
        if p not in self.ratings:
            self.ratings[p] = self.env.create_rating()
        return self.ratings[p]

    def predict(self, p1: int, p2: int) -> float:
        r1 = self._get(p1)
        r2 = self._get(p2)
        # TrueSkill win probability formula
        delta_mu = r1.mu - r2.mu
        sum_sigma = r1.sigma ** 2 + r2.sigma ** 2
        denom = math.sqrt(2 * (self.env.beta ** 2) + sum_sigma)
        return self.env.cdf(delta_mu / denom)

    def update_match(self, winner: int, loser: int, timestamp: int | None = None) -> None:
        w = self._get(winner)
        l = self._get(loser)
        new_w, new_l = self.env.rate_1vs1(w, l)
        self.ratings[winner] = new_w
        self.ratings[loser] = new_l

    def rating(self, player: int) -> float:
        r = self._get(player)
        # Conservative skill estimate (Microsoft's default display)
        return r.mu - 3 * r.sigma

    def has_player(self, player: int) -> bool:
        return player in self.ratings
