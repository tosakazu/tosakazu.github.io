"""Classic Elo."""
import math

from .base import Rater


class EloRater(Rater):
    name = "Elo"

    def __init__(self, initial: float = 1500.0, k: float = 32.0, scale: float = 400.0):
        self.initial = initial
        self.k = k
        self.scale = scale
        self.ratings: dict[int, float] = {}

    def _get(self, p: int) -> float:
        return self.ratings.get(p, self.initial)

    def predict(self, p1: int, p2: int) -> float:
        r1, r2 = self._get(p1), self._get(p2)
        return 1.0 / (1.0 + 10 ** ((r2 - r1) / self.scale))

    def update_match(self, winner: int, loser: int, timestamp: int | None = None) -> None:
        ew = self.predict(winner, loser)
        rw = self._get(winner)
        rl = self._get(loser)
        self.ratings[winner] = rw + self.k * (1 - ew)
        self.ratings[loser] = rl + self.k * (0 - (1 - ew))

    def rating(self, player: int) -> float:
        return self._get(player)

    def has_player(self, player: int) -> bool:
        return player in self.ratings
