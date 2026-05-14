"""
Bradley-Terry via MLE.

This is a batch estimator (not online). To fit the interface, we keep track of
observed pairwise wins and refit lazily.

For the evaluation, we refit on the full training set at the start of test time.
"""
import math

import choix
import numpy as np

from .base import Rater


class BTRater(Rater):
    name = "BradleyTerry"

    def __init__(self, alpha: float = 0.01, max_iter: int = 1000):
        self.alpha = alpha
        self.max_iter = max_iter
        self.records: list[tuple[int, int]] = []  # (winner, loser)
        self._player_to_idx: dict[int, int] = {}
        self._params: np.ndarray | None = None

    def _ensure_idx(self, p: int) -> int:
        if p not in self._player_to_idx:
            self._player_to_idx[p] = len(self._player_to_idx)
        return self._player_to_idx[p]

    def update_match(self, winner: int, loser: int, timestamp: int | None = None) -> None:
        self._ensure_idx(winner)
        self._ensure_idx(loser)
        self.records.append((winner, loser))
        self._params = None  # invalidate

    def fit(self) -> None:
        n = len(self._player_to_idx)
        if n == 0 or not self.records:
            self._params = np.zeros(0)
            return
        data = [(self._player_to_idx[w], self._player_to_idx[l]) for w, l in self.records]
        try:
            self._params = choix.ilsr_pairwise(n, data, alpha=self.alpha, max_iter=self.max_iter)
        except Exception:
            # Fallback to lsr (less robust but faster)
            self._params = choix.lsr_pairwise(n, data, alpha=self.alpha)

    def _rating_vec(self) -> np.ndarray:
        if self._params is None:
            self.fit()
        return self._params

    def predict(self, p1: int, p2: int) -> float:
        if p1 not in self._player_to_idx or p2 not in self._player_to_idx:
            return 0.5
        params = self._rating_vec()
        i = self._player_to_idx[p1]
        j = self._player_to_idx[p2]
        # BT prob
        return float(1.0 / (1.0 + math.exp(params[j] - params[i])))

    def rating(self, player: int) -> float:
        if player not in self._player_to_idx:
            return 0.0
        params = self._rating_vec()
        return float(params[self._player_to_idx[player]])

    def has_player(self, player: int) -> bool:
        return player in self._player_to_idx
