"""Glicko2 via the `glicko2` library."""
import math

from glicko2 import Player

from .base import Rater


class Glicko2Rater(Rater):
    name = "Glicko2"

    def __init__(self, initial_r: float = 1500.0, initial_rd: float = 350.0, initial_vol: float = 0.06):
        self.initial_r = initial_r
        self.initial_rd = initial_rd
        self.initial_vol = initial_vol
        self.ratings: dict[int, Player] = {}

    def _get(self, p: int) -> Player:
        if p not in self.ratings:
            self.ratings[p] = Player(rating=self.initial_r, rd=self.initial_rd, vol=self.initial_vol)
        return self.ratings[p]

    def predict(self, p1: int, p2: int) -> float:
        a = self._get(p1)
        b = self._get(p2)
        # Glicko2 prediction formula (in Glicko rating space)
        q = math.log(10) / 400.0
        rd = math.sqrt(a.rd ** 2 + b.rd ** 2)
        g = 1.0 / math.sqrt(1.0 + 3.0 * (q * rd) ** 2 / (math.pi ** 2))
        return 1.0 / (1.0 + 10 ** (-g * (a.rating - b.rating) / 400.0))

    def update_match(self, winner: int, loser: int, timestamp: int | None = None) -> None:
        w = self._get(winner)
        l = self._get(loser)
        w_rating, w_rd = w.rating, w.rd
        l_rating, l_rd = l.rating, l.rd

        w.update_player([l_rating], [l_rd], [1])
        l.update_player([w_rating], [w_rd], [0])

    def rating(self, player: int) -> float:
        return self._get(player).rating

    def has_player(self, player: int) -> bool:
        return player in self.ratings
