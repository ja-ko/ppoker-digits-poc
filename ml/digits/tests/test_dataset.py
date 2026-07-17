import numpy as np
import torch

from dataset import (
    CompositionDataset,
    CompositionSpec,
    GlyphAugmentation,
    canonical_label,
    compose,
    composition_spec,
    grouped_glyph_ids,
    has_repeated_digit,
    split_test_glyphs,
)


def test_canonical_labels_are_balanced_and_valid() -> None:
    labels = [
        canonical_label(index % 3 + 1, np.random.default_rng(index))
        for index in range(3000)
    ]
    assert [sum(len(label) == length for label in labels) for length in (1, 2, 3)] == [
        1000,
        1000,
        1000,
    ]
    assert all(label == "0" or not label.startswith("0") for label in labels)
    assert all(0 <= int(label) <= 255 for label in labels)


def test_repeated_digit_detection() -> None:
    assert has_repeated_digit("11")
    assert has_repeated_digit("100")
    assert has_repeated_digit("222")
    assert not has_repeated_digit("13")


def test_split_and_composition_are_deterministic_and_disjoint() -> None:
    targets = torch.arange(10).repeat_interleave(40)
    pools_a = split_test_glyphs(targets, seed=7, pool_size_per_digit=10)
    pools_b = split_test_glyphs(targets, seed=7, pool_size_per_digit=10)
    assert all(np.array_equal(pools_a[name], pools_b[name]) for name in pools_a)
    sets = [set(ids.tolist()) for ids in pools_a.values()]
    assert len(set.union(*sets)) == sum(map(len, sets))

    groups = grouped_glyph_ids(targets, pools_a["model_selection"])
    assert composition_spec(42, 99, groups) == composition_spec(42, 99, groups)
    assert composition_spec(42, 99, groups) != composition_spec(43, 99, groups)


def test_composition_shape_range_and_distinct_position_glyphs() -> None:
    targets = torch.arange(10).repeat_interleave(20)
    glyphs = torch.zeros((200, 28, 28), dtype=torch.uint8)
    glyphs[:, 5:23, 9:19] = 255
    dataset = CompositionDataset(glyphs, targets, range(200), count=9, seed=5)
    for index in range(len(dataset)):
        image, label = dataset[index]
        assert image.shape == (1, 32, 128)
        assert image.min() >= 0 and image.max() <= 1
        assert len(label) == index % 3 + 1
        spec = composition_spec(index, 5, dataset.groups)
        assert len(spec.glyph_ids) == len(set(spec.glyph_ids))


def test_independent_translation_changes_relative_glyph_placement() -> None:
    glyphs = torch.zeros((2, 28, 28), dtype=torch.uint8)
    glyphs[:, 7:21, 10:18] = 255

    def augmentation(translate_x: int, translate_y: int) -> GlyphAugmentation:
        return GlyphAugmentation(
            angle=0.0,
            translate_x=translate_x,
            translate_y=translate_y,
            scale=1.0,
            shear=0.0,
            thickness=0,
            vertical_scale=1.0,
            baseline=0,
            spacing_after=2,
        )

    expanded = CompositionSpec(
        "11",
        (0, 1),
        (augmentation(-1, -1), augmentation(1, 1)),
        1.0,
        0.5,
        0,
    )
    contracted = CompositionSpec(
        "11",
        (0, 1),
        (augmentation(1, 1), augmentation(-1, -1)),
        1.0,
        0.5,
        0,
    )
    assert not torch.equal(compose(glyphs, expanded), compose(glyphs, contracted))
