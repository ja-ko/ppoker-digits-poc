import gzip
import hashlib
import zipfile

from download import extract_gzip_member_verified


def test_extraction_verifies_and_atomically_replaces_corrupt_existing_file(tmp_path) -> None:
    payload = b"verified EMNIST fixture"
    archive = tmp_path / "fixture.zip"
    member = "gzip/emnist-fixture.gz"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(member, gzip.compress(payload))
    output = tmp_path / "emnist-fixture"
    output.write_bytes(b"corrupt")

    with zipfile.ZipFile(archive) as bundle:
        extract_gzip_member_verified(
            bundle, member, output, hashlib.sha256(payload).hexdigest()
        )

    assert output.read_bytes() == payload
    assert not output.with_suffix(output.suffix + ".part").exists()
