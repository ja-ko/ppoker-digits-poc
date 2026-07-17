"""Checksum-verified acquisition of the exact upstream model and EMNIST data."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import shutil
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / "artifacts"

CHECKPOINT_URL = (
    "https://github.com/zjykzj/crnn-ctc/releases/download/v1.3.0/"
    "crnn_tiny-emnist.pth"
)
CHECKPOINT_SHA256 = "6d2a653513fd71f9d5de1fc238311dc017d285f0bbc55e09da7ed9eea80479c9"
EMNIST_URL = "https://biometrics.nist.gov/cs_links/EMNIST/gzip.zip"
EMNIST_SHA256 = "fb9bb67e33772a9cc0b895e4ecf36d2cf35be8b709693c3564cea2a019fcda8e"

CHECKPOINT_PATH = ARTIFACTS / "upstream" / "crnn_tiny-emnist.pth"
EMNIST_ARCHIVE = ARTIFACTS / "downloads" / "emnist-gzip.zip"
EMNIST_RAW = ARTIFACTS / "data" / "EMNIST" / "raw"
EMNIST_DIGITS_FILES = {
    "emnist-digits-train-images-idx3-ubyte.gz": "0fd17ca7bc21f8a10f68356f3c60e9c36ef287895394791ecd051c7a15ea4acd",
    "emnist-digits-train-labels-idx1-ubyte.gz": "86013a4b932e35477a90ecff239cf492643795cf3c68dd6b7fae3264fb24316b",
    "emnist-digits-test-images-idx3-ubyte.gz": "3075fed46264a655192bd2ac1dafba8ce0c5184802d74acd0a123e25daa15c50",
    "emnist-digits-test-labels-idx1-ubyte.gz": "a456cc5cfc928851403b513f94937b9d7570f424ea6d56dce3b28f6c0723608a",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_verified(url: str, destination: Path, expected_sha256: str) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and sha256(destination) == expected_sha256:
        print(f"verified existing {destination}")
        return destination

    temporary = destination.with_suffix(destination.suffix + ".part")
    temporary.unlink(missing_ok=True)
    print(f"downloading {url}")
    with urllib.request.urlopen(url) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    actual = sha256(temporary)
    if actual != expected_sha256:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(
            f"SHA-256 mismatch for {url}: expected {expected_sha256}, got {actual}"
        )
    temporary.replace(destination)
    print(f"verified {destination}: {actual}")
    return destination


def setup_checkpoint() -> Path:
    return download_verified(CHECKPOINT_URL, CHECKPOINT_PATH, CHECKPOINT_SHA256)


def extract_gzip_member_verified(
    bundle: zipfile.ZipFile,
    member: str,
    output: Path,
    expected_sha256: str,
) -> None:
    if output.exists() and sha256(output) == expected_sha256:
        print(f"verified existing {output}")
        return
    temporary = output.with_suffix(output.suffix + ".part")
    temporary.unlink(missing_ok=True)
    try:
        with bundle.open(member) as zipped:
            with gzip.GzipFile(fileobj=zipped) as compressed, temporary.open("wb") as raw:
                shutil.copyfileobj(compressed, raw, length=1024 * 1024)
        actual = sha256(temporary)
        if actual != expected_sha256:
            raise RuntimeError(
                f"SHA-256 mismatch for extracted {member}: "
                f"expected {expected_sha256}, got {actual}"
            )
        temporary.replace(output)
        print(f"verified extracted {output}: {actual}")
    finally:
        temporary.unlink(missing_ok=True)


def setup_emnist() -> Path:
    archive = download_verified(EMNIST_URL, EMNIST_ARCHIVE, EMNIST_SHA256)
    EMNIST_RAW.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        members = {Path(name).name: name for name in bundle.namelist()}
        for compressed_name, expected_sha256 in EMNIST_DIGITS_FILES.items():
            output = EMNIST_RAW / compressed_name.removesuffix(".gz")
            extract_gzip_member_verified(
                bundle, members[compressed_name], output, expected_sha256
            )
    return EMNIST_RAW


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("asset", choices=("checkpoint", "emnist", "all"))
    args = parser.parse_args()
    if args.asset in {"checkpoint", "all"}:
        setup_checkpoint()
    if args.asset in {"emnist", "all"}:
        setup_emnist()


if __name__ == "__main__":
    main()
