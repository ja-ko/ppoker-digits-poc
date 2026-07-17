"""Measured CPU fine-tuning of CRNN Tiny on deterministic EMNIST compositions."""

from __future__ import annotations

import argparse
import json
import os
import random
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader

from dataset import CompositionDataset, collate_compositions, dataset_for_manifest, load_emnist
from download import CHECKPOINT_SHA256
from evaluate import evaluate_model
from model import BLANK_INDEX, load_checkpoint
from provenance import (
    pipeline_source_sha256,
    select_model_epoch,
    sha256_file,
    utc_now,
    validate_training_history,
)


def configure(seed: int, threads: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(threads)
    torch.use_deterministic_algorithms(True)


def train_dataset(data_root: Path, count: int, seed: int) -> CompositionDataset:
    emnist = load_emnist(data_root, train=True)
    return CompositionDataset(
        emnist.data,
        emnist.targets,
        range(len(emnist)),
        count,
        seed,
    )


def loader_for(
    dataset: CompositionDataset,
    batch_size: int,
    workers: int,
    shuffle_seed: int,
) -> DataLoader:
    generator = torch.Generator().manual_seed(shuffle_seed)
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=True,
        generator=generator,
        num_workers=workers,
        collate_fn=collate_compositions,
        persistent_workers=workers > 0,
    )


def train_batch(model, criterion, optimizer, batch) -> float:
    images, targets, target_lengths, _ = batch
    optimizer.zero_grad(set_to_none=True)
    output = model(images)
    input_lengths = torch.full(
        (images.shape[0],), output.shape[1], dtype=torch.long
    )
    loss = criterion(output.transpose(0, 1), targets, input_lengths, target_lengths)
    loss.backward()
    nn.utils.clip_grad_norm_(model.parameters(), 5.0)
    optimizer.step()
    return float(loss.detach())


def benchmark(args: argparse.Namespace) -> dict:
    started_at = utc_now()
    configure(args.seed, args.threads)
    model = load_checkpoint(args.checkpoint).train()
    criterion = nn.CTCLoss(blank=BLANK_INDEX, zero_infinity=True)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4, weight_decay=1e-5)
    count = args.batch_size * (args.steps + 2)
    loader = loader_for(
        train_dataset(args.data_root, count, args.seed),
        args.batch_size,
        args.workers,
        args.seed,
    )
    measured_samples = 0
    losses = []
    iterator = iter(loader)
    for _ in range(2):
        train_batch(model, criterion, optimizer, next(iterator))
    started = time.perf_counter()
    for _ in range(args.steps):
        batch = next(iterator)
        losses.append(train_batch(model, criterion, optimizer, batch))
        measured_samples += batch[0].shape[0]
    measured_seconds = time.perf_counter() - started
    report = {
        "started_at_utc": started_at,
        "completed_at_utc": utc_now(),
        "pipeline_source_sha256": pipeline_source_sha256(),
        "device": "cpu",
        "logical_cpus": os.cpu_count() or 1,
        "torch_threads": args.threads,
        "data_loader_workers": args.workers,
        "batch_size": args.batch_size,
        "warmup_batches": 2,
        "measured_batches": args.steps,
        "measured_samples": measured_samples,
        "seconds": measured_seconds,
        "samples_per_second": measured_samples / measured_seconds,
        "last_loss": losses[-1],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return report


def fit(args: argparse.Namespace) -> dict:
    started_at = utc_now()
    source_before_training = pipeline_source_sha256()
    initial_checkpoint_sha256 = sha256_file(args.checkpoint)
    if initial_checkpoint_sha256 != args.expected_initial_checkpoint_sha256:
        raise ValueError(
            "initial checkpoint SHA-256 mismatch: "
            f"expected {args.expected_initial_checkpoint_sha256}, "
            f"got {initial_checkpoint_sha256}"
        )
    configure(args.seed, args.threads)
    model = load_checkpoint(args.checkpoint)
    selection = dataset_for_manifest(args.data_root, "model_selection")
    baseline = evaluate_model(model, selection, args.batch_size, args.workers)
    criterion = nn.CTCLoss(blank=BLANK_INDEX, zero_infinity=True)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=1e-5
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=args.epochs, eta_min=args.learning_rate / 10
    )
    best_accuracy = -1.0
    epochs = []
    start_run = time.perf_counter()
    for epoch in range(1, args.epochs + 1):
        model.train()
        dataset = train_dataset(
            args.data_root, args.samples_per_epoch, args.seed + epoch * 1000
        )
        loader = loader_for(dataset, args.batch_size, args.workers, args.seed + epoch)
        loss_total = 0.0
        sample_total = 0
        started = time.perf_counter()
        for batch in loader:
            loss = train_batch(model, criterion, optimizer, batch)
            batch_count = batch[0].shape[0]
            loss_total += loss * batch_count
            sample_total += batch_count
        seconds = time.perf_counter() - started
        selection_metrics = evaluate_model(
            model, selection, args.batch_size, args.workers
        )
        accuracy = selection_metrics["overall"]["accuracy"]
        selected = accuracy > best_accuracy
        if selected:
            best_accuracy = accuracy
            args.output.parent.mkdir(parents=True, exist_ok=True)
            torch.save(model.state_dict(), args.output)
        epoch_report = {
            "epoch": epoch,
            "learning_rate": optimizer.param_groups[0]["lr"],
            "mean_ctc_loss": loss_total / sample_total,
            "seconds": seconds,
            "samples_per_second": sample_total / seconds,
            "model_selection": selection_metrics,
            "became_best_so_far": selected,
        }
        epochs.append(epoch_report)
        print(json.dumps(epoch_report))
        scheduler.step()

    source_after_training = pipeline_source_sha256()
    if source_after_training != source_before_training:
        raise RuntimeError("pipeline source changed while training was running")
    best_epoch, selected_accuracy = select_model_epoch(epochs)
    if selected_accuracy != best_accuracy:
        raise RuntimeError("selected epoch accuracy does not match tracked best accuracy")
    for epoch_report in epochs:
        epoch_report["selected_for_export"] = epoch_report["epoch"] == best_epoch
    validate_training_history(epochs, args.epochs)
    report = {
        "started_at_utc": started_at,
        "completed_at_utc": utc_now(),
        "pipeline_source_sha256_before_training": source_before_training,
        "pipeline_source_sha256_after_training": source_after_training,
        "pipeline_source_unchanged_during_training": True,
        "device": "cpu",
        "initial_checkpoint": str(args.checkpoint),
        "initial_checkpoint_verification": {
            "expected_sha256": args.expected_initial_checkpoint_sha256,
            "actual_sha256": initial_checkpoint_sha256,
            "verified_before_training": True,
        },
        "seed": args.seed,
        "epochs_requested": args.epochs,
        "epochs_completed": args.epochs,
        "samples_per_epoch": args.samples_per_epoch,
        "total_training_compositions": args.epochs * args.samples_per_epoch,
        "batch_size": args.batch_size,
        "workers": args.workers,
        "torch_threads": args.threads,
        "optimizer": "AdamW",
        "learning_rate": args.learning_rate,
        "weight_decay": 1e-5,
        "scheduler": "CosineAnnealingLR eta_min=learning_rate/10",
        "gradient_clip_norm": 5.0,
        "baseline_model_selection": baseline,
        "best_model_selection_accuracy": best_accuracy,
        "best_epoch": best_epoch,
        "model_selection_evaluation": {
            "evaluation_role": "model_selection",
            "manifest": "model_selection",
            "composition_count": len(selection),
            "selected_epoch": best_epoch,
            "selection_rule": "maximum overall exact-match accuracy; earliest epoch wins ties",
            "history_flag_semantics": "became_best_so_far is provisional; selected_for_export marks only the final selected epoch",
        },
        "wall_seconds": time.perf_counter() - start_run,
        "selected_checkpoint_sha256": sha256_file(args.output),
        "augmentation_tuning": {
            "performed": False,
            "reason": "No model-selection-driven augmentation tuning was needed; review remediation made configured translation effective before this full rerun.",
        },
        "epochs": epochs,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data-root", type=Path, default=Path("artifacts/data"))
    common.add_argument(
        "--checkpoint",
        type=Path,
        default=Path("artifacts/upstream/crnn_tiny-emnist.pth"),
    )
    common.add_argument("--batch-size", type=int, default=256)
    common.add_argument("--workers", type=int, default=8)
    common.add_argument("--threads", type=int, default=16)
    common.add_argument("--seed", type=int, default=72016)

    benchmark_parser = subparsers.add_parser("benchmark", parents=[common])
    benchmark_parser.add_argument("--steps", type=int, default=20)
    benchmark_parser.add_argument(
        "--output", type=Path, default=Path("reports/cpu-benchmark.json")
    )

    fit_parser = subparsers.add_parser("fit", parents=[common])
    fit_parser.add_argument("--epochs", type=int, default=10)
    fit_parser.add_argument("--samples-per-epoch", type=int, default=100000)
    fit_parser.add_argument("--learning-rate", type=float, default=1e-4)
    fit_parser.add_argument(
        "--expected-initial-checkpoint-sha256",
        default=CHECKPOINT_SHA256,
    )
    fit_parser.add_argument(
        "--output", type=Path, default=Path("artifacts/runs/best.pth")
    )
    fit_parser.add_argument(
        "--report", type=Path, default=Path("reports/training.json")
    )

    args = parser.parse_args()
    if args.command == "benchmark":
        benchmark(args)
    else:
        fit(args)


if __name__ == "__main__":
    main()
