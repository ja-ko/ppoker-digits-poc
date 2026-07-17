"""Deterministic canonical labels, EMNIST pool separation, and composition."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import torch
from torch.nn import functional as F
from torch.utils.data import Dataset
from torchvision.datasets import EMNIST
from torchvision.transforms import InterpolationMode
from torchvision.transforms import functional as TF

HEIGHT = 32
WIDTH = 128
COMPOSITION_VERSION = "digits-compose-v2"
MANIFEST_PATH = Path(__file__).resolve().parent / "manifests" / "v2.json"


@dataclass(frozen=True)
class GlyphAugmentation:
    angle: float
    translate_x: int
    translate_y: int
    scale: float
    shear: float
    thickness: int
    vertical_scale: float
    baseline: int
    spacing_after: int


@dataclass(frozen=True)
class CompositionSpec:
    label: str
    glyph_ids: tuple[int, ...]
    glyphs: tuple[GlyphAugmentation, ...]
    sequence_scale: float
    horizontal_position: float
    vertical_offset: int


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, Any]:
    return json.loads(path.read_text())


def canonical_label(length: int, rng: np.random.Generator) -> str:
    bounds = {1: (0, 9), 2: (10, 99), 3: (100, 255)}
    if length not in bounds:
        raise ValueError(f"unsupported canonical label length: {length}")
    low, high = bounds[length]
    return str(int(rng.integers(low, high + 1)))


def has_repeated_digit(label: str) -> bool:
    return len(set(label)) != len(label)


def split_test_glyphs(
    targets: torch.Tensor | np.ndarray,
    seed: int,
    pool_size_per_digit: int,
) -> dict[str, np.ndarray]:
    values = np.asarray(targets)
    names = ("model_selection", "calibration", "final_test", "reserve")
    result: dict[str, list[np.ndarray]] = {name: [] for name in names}
    for digit in range(10):
        ids = np.flatnonzero(values == digit)
        shuffled = np.random.default_rng(seed + digit).permutation(ids)
        required = pool_size_per_digit * len(names)
        if len(shuffled) < required:
            raise ValueError(f"digit {digit} has {len(shuffled)} glyphs, need {required}")
        for offset, name in enumerate(names):
            start = offset * pool_size_per_digit
            result[name].append(shuffled[start : start + pool_size_per_digit])
    return {name: np.concatenate(parts) for name, parts in result.items()}


def grouped_glyph_ids(targets: torch.Tensor | np.ndarray, ids: Sequence[int]) -> dict[int, np.ndarray]:
    values = np.asarray(targets)
    selected = np.asarray(ids, dtype=np.int64)
    return {digit: selected[values[selected] == digit] for digit in range(10)}


def pool_sha256(ids: Sequence[int]) -> str:
    ordered = np.asarray(ids, dtype="<i8")
    return hashlib.sha256(ordered.tobytes()).hexdigest()


def composition_spec(index: int, seed: int, groups: dict[int, np.ndarray]) -> CompositionSpec:
    rng = np.random.default_rng(np.random.SeedSequence([seed, index]))
    label = canonical_label(index % 3 + 1, rng)
    used: set[int] = set()
    glyph_ids: list[int] = []
    augmentations: list[GlyphAugmentation] = []
    for digit_text in label:
        candidates = groups[int(digit_text)]
        glyph_id = int(candidates[int(rng.integers(0, len(candidates)))])
        while glyph_id in used and len(candidates) > len(used):
            glyph_id = int(candidates[int(rng.integers(0, len(candidates)))])
        used.add(glyph_id)
        glyph_ids.append(glyph_id)
        augmentations.append(
            GlyphAugmentation(
                angle=float(rng.uniform(-7.0, 7.0)),
                translate_x=int(rng.integers(-1, 2)),
                translate_y=int(rng.integers(-1, 2)),
                scale=float(rng.uniform(0.92, 1.07)),
                shear=float(rng.uniform(-5.0, 5.0)),
                thickness=int(rng.choice((-1, 0, 0, 0, 1))),
                vertical_scale=float(rng.uniform(0.92, 1.08)),
                baseline=int(rng.integers(-2, 3)),
                spacing_after=int(rng.integers(-2, 5)),
            )
        )
    return CompositionSpec(
        label=label,
        glyph_ids=tuple(glyph_ids),
        glyphs=tuple(augmentations),
        sequence_scale=float(rng.uniform(0.92, 1.04)),
        horizontal_position=float(rng.uniform(0.08, 0.92)),
        vertical_offset=int(rng.integers(-1, 2)),
    )


def _content_crop(image: torch.Tensor) -> torch.Tensor:
    positions = torch.nonzero(image[0] > 0.02)
    if not len(positions):
        return image
    y0, x0 = positions.min(dim=0).values.tolist()
    y1, x1 = positions.max(dim=0).values.tolist()
    return image[:, y0 : y1 + 1, x0 : x1 + 1]


def _render_glyph(image: torch.Tensor, augmentation: GlyphAugmentation) -> torch.Tensor:
    # torchvision stores EMNIST transposed relative to normal visual orientation.
    image = image.T.unsqueeze(0).float().div(255.0)
    image = TF.affine(
        image,
        angle=augmentation.angle,
        translate=[0, 0],
        scale=augmentation.scale,
        shear=[augmentation.shear, 0.0],
        interpolation=InterpolationMode.BILINEAR,
        fill=0.0,
    )
    if augmentation.thickness == 1:
        image = F.max_pool2d(image, kernel_size=3, stride=1, padding=1)
    elif augmentation.thickness == -1:
        image = 1.0 - F.max_pool2d(1.0 - image, kernel_size=3, stride=1, padding=1)
    image = _content_crop(image)
    target_height = max(18, min(28, round(image.shape[1] * augmentation.vertical_scale)))
    target_width = max(4, round(image.shape[2] * target_height / image.shape[1]))
    return F.interpolate(
        image.unsqueeze(0),
        size=(target_height, target_width),
        mode="bilinear",
        align_corners=False,
    )[0]


def compose(glyph_data: torch.Tensor, spec: CompositionSpec) -> torch.Tensor:
    rendered = [
        _render_glyph(glyph_data[glyph_id], augmentation)
        for glyph_id, augmentation in zip(spec.glyph_ids, spec.glyphs, strict=True)
    ]
    total_width = sum(glyph.shape[2] for glyph in rendered) + sum(
        augmentation.spacing_after for augmentation in spec.glyphs[:-1]
    )
    scratch = torch.zeros((1, HEIGHT, max(total_width + 12, WIDTH)))
    x = 6
    for glyph, augmentation in zip(rendered, spec.glyphs, strict=True):
        place_x = x + augmentation.translate_x
        y = (
            (HEIGHT - glyph.shape[1]) // 2
            + augmentation.baseline
            + augmentation.translate_y
        )
        y = max(0, min(HEIGHT - glyph.shape[1], y))
        x_end = min(scratch.shape[2], place_x + glyph.shape[2])
        if x_end > place_x:
            scratch[:, y : y + glyph.shape[1], place_x:x_end] = torch.maximum(
                scratch[:, y : y + glyph.shape[1], place_x:x_end],
                glyph[:, :, : x_end - place_x],
            )
        x += glyph.shape[2] + augmentation.spacing_after

    sequence = _content_crop(scratch)
    scale = min(spec.sequence_scale, 26 / sequence.shape[1], 116 / sequence.shape[2])
    output_height = max(1, round(sequence.shape[1] * scale))
    output_width = max(1, round(sequence.shape[2] * scale))
    sequence = F.interpolate(
        sequence.unsqueeze(0),
        size=(output_height, output_width),
        mode="bilinear",
        align_corners=False,
    )[0]
    available_x = WIDTH - output_width
    left = round(available_x * spec.horizontal_position)
    top = max(0, min(HEIGHT - output_height, (HEIGHT - output_height) // 2 + spec.vertical_offset))
    canvas = torch.zeros((1, HEIGHT, WIDTH))
    canvas[:, top : top + output_height, left : left + output_width] = sequence
    return canvas.clamp_(0.0, 1.0)


class CompositionDataset(Dataset[tuple[torch.Tensor, str]]):
    def __init__(
        self,
        glyph_data: torch.Tensor,
        targets: torch.Tensor,
        glyph_ids: Sequence[int],
        count: int,
        seed: int,
    ) -> None:
        self.glyph_data = glyph_data
        self.groups = grouped_glyph_ids(targets, glyph_ids)
        self.count = count
        self.seed = seed

    def __len__(self) -> int:
        return self.count

    def __getitem__(self, index: int) -> tuple[torch.Tensor, str]:
        spec = composition_spec(index, self.seed, self.groups)
        return compose(self.glyph_data, spec), spec.label


def collate_compositions(
    batch: list[tuple[torch.Tensor, str]],
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, list[str]]:
    images, labels = zip(*batch, strict=True)
    lengths = torch.tensor([len(label) for label in labels], dtype=torch.long)
    targets = torch.tensor([int(char) for label in labels for char in label], dtype=torch.long)
    return torch.stack(images), targets, lengths, list(labels)


def load_emnist(data_root: Path, train: bool) -> EMNIST:
    return EMNIST(data_root, split="digits", train=train, download=False)


def dataset_for_manifest(data_root: Path, name: str) -> CompositionDataset:
    manifest = load_manifest()
    definition = manifest["compositions"][name]
    emnist = load_emnist(data_root, train=False)
    pools = split_test_glyphs(
        emnist.targets,
        manifest["glyph_split"]["seed"],
        manifest["glyph_split"]["pool_size_per_digit"],
    )
    return CompositionDataset(
        emnist.data,
        emnist.targets,
        pools[definition["glyph_pool"]],
        definition["count"],
        definition["seed"],
    )
