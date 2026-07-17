"""CRNN Tiny v1.3.0-compatible architecture for width-128 digit sequences."""

from __future__ import annotations

from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F

BLANK_INDEX = 10
NUM_CLASSES = 11


class CrnnTiny(nn.Module):
    """Apache-2.0 zjykzj/crnn-ctc Tiny architecture, modified 2026-07-16."""

    def __init__(self) -> None:
        super().__init__()
        self.cnn = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=3, stride=2, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.Conv2d(32, 32, kernel_size=3, stride=1, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.Conv2d(32, 32, kernel_size=3, stride=(2, 1), padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.Conv2d(32, 64, kernel_size=3, stride=1, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.Conv2d(64, 64, kernel_size=3, stride=(2, 1), padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.Conv2d(64, 64, kernel_size=2, stride=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
        )
        # A 32-pixel input is reduced to height 3, exactly as upstream.
        rnn_input_size = 64 * 3
        self.rnn = nn.GRU(
            input_size=rnn_input_size,
            hidden_size=rnn_input_size // 2,
            num_layers=2,
            batch_first=True,
            bidirectional=True,
        )
        self.fc = nn.Linear(rnn_input_size, NUM_CLASSES)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        value = self.cnn(value)
        value = value.permute(0, 3, 1, 2).contiguous()
        value = value.view(value.size(0), value.size(1), -1)
        value, _ = self.rnn(value)
        return F.log_softmax(self.fc(value), dim=-1)


def load_checkpoint(path: Path | str) -> CrnnTiny:
    model = CrnnTiny()
    state = torch.load(path, map_location="cpu", weights_only=True)
    state = {key.removeprefix("module."): value for key, value in state.items()}
    model.load_state_dict(state, strict=True)
    return model
