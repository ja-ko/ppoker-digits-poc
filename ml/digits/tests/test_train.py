from argparse import Namespace
from copy import deepcopy

import pytest
import torch

import train
from provenance import sha256_file, validate_training_history


def test_benchmark_control_path_completes_without_training_state(monkeypatch, tmp_path) -> None:
    model = torch.nn.Linear(1, 1)
    batch = (torch.zeros((2, 1)), None, None, None)
    monkeypatch.setattr(train, "configure", lambda *_: None)
    monkeypatch.setattr(train, "load_checkpoint", lambda _: model)
    monkeypatch.setattr(train, "train_dataset", lambda *_: object())
    monkeypatch.setattr(train, "loader_for", lambda *_: [batch, batch, batch])
    monkeypatch.setattr(train, "train_batch", lambda *_: 0.25)
    monkeypatch.setattr(train, "pipeline_source_sha256", lambda: {"train.py": "hash"})
    monkeypatch.setattr(train.os, "cpu_count", lambda: 12)

    report = train.benchmark(
        Namespace(
            seed=1,
            threads=1,
            checkpoint=tmp_path / "upstream.pth",
            data_root=tmp_path,
            batch_size=2,
            workers=0,
            steps=1,
            output=tmp_path / "benchmark.json",
        )
    )
    assert report["measured_batches"] == 1
    assert report["measured_samples"] == 2
    assert report["last_loss"] == 0.25
    assert report["logical_cpus"] == 12


def test_fit_one_epoch_control_path_selects_best_epoch(monkeypatch, tmp_path) -> None:
    checkpoint = tmp_path / "upstream.pth"
    checkpoint.write_bytes(b"upstream fixture")
    selected_checkpoint = tmp_path / "selected.pth"
    report_path = tmp_path / "training.json"
    model = torch.nn.Linear(1, 1)
    selection = [0, 1, 2]
    batch = (torch.zeros((2, 1)), None, None, None)
    metrics = {
        "decoder": "greedy CTC",
        "overall": {"correct": 3, "total": 3, "accuracy": 1.0},
        "by_length": {},
        "repeated_digits": {"correct": 0, "total": 0, "accuracy": 0.0},
    }
    source_hashes = {"train.py": "stable"}

    monkeypatch.setattr(train, "configure", lambda *_: None)
    monkeypatch.setattr(train, "load_checkpoint", lambda _: model)
    monkeypatch.setattr(train, "dataset_for_manifest", lambda *_: selection)
    monkeypatch.setattr(train, "evaluate_model", lambda *_: metrics)
    monkeypatch.setattr(train, "train_dataset", lambda *_: object())
    monkeypatch.setattr(train, "loader_for", lambda *_: [batch])
    def fake_train_batch(_, __, optimizer, ___):
        optimizer.step()
        return 0.1

    monkeypatch.setattr(train, "train_batch", fake_train_batch)
    monkeypatch.setattr(train, "pipeline_source_sha256", lambda: source_hashes)

    report = train.fit(
        Namespace(
            seed=1,
            threads=1,
            checkpoint=checkpoint,
            expected_initial_checkpoint_sha256=sha256_file(checkpoint),
            data_root=tmp_path,
            batch_size=2,
            workers=0,
            learning_rate=1e-4,
            epochs=1,
            samples_per_epoch=2,
            output=selected_checkpoint,
            report=report_path,
        )
    )
    assert report["best_epoch"] == 1
    assert report["model_selection_evaluation"]["selected_epoch"] == 1
    assert report["model_selection_evaluation"]["composition_count"] == 3
    assert report["epochs"][0]["became_best_so_far"] is True
    assert report["epochs"][0]["selected_for_export"] is True
    assert (
        validate_training_history(report["epochs"], report["epochs_completed"])[
            "flag_format"
        ]
        == "future_explicit"
    )
    assert selected_checkpoint.exists()


def test_future_history_flags_preserve_best_so_far_and_final_selection() -> None:
    epochs = [
        {
            "epoch": 1,
            "model_selection": {"overall": {"accuracy": 0.5}},
            "became_best_so_far": True,
            "selected_for_export": False,
        },
        {
            "epoch": 2,
            "model_selection": {"overall": {"accuracy": 0.75}},
            "became_best_so_far": True,
            "selected_for_export": True,
        },
        {
            "epoch": 3,
            "model_selection": {"overall": {"accuracy": 0.75}},
            "became_best_so_far": False,
            "selected_for_export": False,
        },
    ]
    result = validate_training_history(epochs, len(epochs))
    assert result["selected_record"] is epochs[1]

    wrong_best_so_far = deepcopy(epochs)
    wrong_best_so_far[2]["became_best_so_far"] = True
    with pytest.raises(ValueError, match="strict best-so-far"):
        validate_training_history(wrong_best_so_far, len(wrong_best_so_far))

    wrong_export_selection = deepcopy(epochs)
    wrong_export_selection[2]["selected_for_export"] = True
    with pytest.raises(ValueError, match="selected_for_export"):
        validate_training_history(wrong_export_selection, len(wrong_export_selection))
