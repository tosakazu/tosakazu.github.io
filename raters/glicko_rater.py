"""Glicko (original, Mark Glickman 1995).

Ratings updated per-match (rating period = 1 match) for online use.
"""
import math

from .base import Rater

Q = math.log(10) / 400.0


class GlickoRater(Rater):
    name = "Glicko"

    def __init__(self, initial_r: float = 1500.0, initial_rd: float = 350.0, c: float = 0.0):
        self.initial_r = initial_r
        self.initial_rd = initial_rd
        self.c = c  # RD growth over time (ignored when c=0 for per-match update)
        self.ratings: dict[int, tuple[float, float]] = {}

    def _get(self, p: int) -> tuple[float, float]:
        return self.ratings.get(p, (self.initial_r, self.initial_rd))

    @staticmethod
    def _g(rd: float) -> float:
        return 1.0 / math.sqrt(1.0 + 3.0 * (Q * rd) ** 2 / (math.pi ** 2))

    @staticmethod
    def _E(r: float, rj: float, rdj: float) -> float:
        return 1.0 / (1.0 + 10 ** (-GlickoRater._g(rdj) * (r - rj) / 400.0))

    def predict(self, p1: int, p2: int) -> float:
        r1, rd1 = self._get(p1)
        r2, rd2 = self._get(p2)
        # Combined RD for prediction
        combined_rd = math.sqrt(rd1 ** 2 + rd2 ** 2)
        return 1.0 / (1.0 + 10 ** (-self._g(combined_rd) * (r1 - r2) / 400.0))

    def update_match(self, winner: int, loser: int, timestamp: int | None = None) -> None:
        # Glicko update: treat each match as a mini rating period with one opponent.
        r_w, rd_w = self._get(winner)
        r_l, rd_l = self._get(loser)

        # Update winner vs loser
        g_l = self._g(rd_l)
        e_wl = 1.0 / (1.0 + 10 ** (-g_l * (r_w - r_l) / 400.0))
        d2_w = 1.0 / (Q * Q * g_l * g_l * e_wl * (1 - e_wl))
        new_r_w = r_w + (Q / (1.0 / (rd_w ** 2) + 1.0 / d2_w)) * g_l * (1 - e_wl)
        new_rd_w = math.sqrt(1.0 / (1.0 / (rd_w ** 2) + 1.0 / d2_w))

        # Update loser vs winner
        g_w = self._g(rd_w)
        e_lw = 1.0 / (1.0 + 10 ** (-g_w * (r_l - r_w) / 400.0))
        d2_l = 1.0 / (Q * Q * g_w * g_w * e_lw * (1 - e_lw))
        new_r_l = r_l + (Q / (1.0 / (rd_l ** 2) + 1.0 / d2_l)) * g_w * (0 - e_lw)
        new_rd_l = math.sqrt(1.0 / (1.0 / (rd_l ** 2) + 1.0 / d2_l))

        self.ratings[winner] = (new_r_w, new_rd_w)
        self.ratings[loser] = (new_r_l, new_rd_l)

    def rating(self, player: int) -> float:
        return self._get(player)[0]

    def has_player(self, player: int) -> bool:
        return player in self.ratings
