"""Actual supported Argon2id profile and byte-verifier compatibility for the broker."""

import pytest
from argon2 import PasswordHasher, extract_parameters
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from argon2.low_level import Type
from argon2.profiles import RFC_9106_LOW_MEMORY

SECRET = "synthetic-only-verifier-secret"  # noqa: S105 - finite dependency fixture


@pytest.fixture(scope="module")
def verifier():
    hasher = PasswordHasher.from_parameters(RFC_9106_LOW_MEMORY)
    return hasher, hasher.hash(SECRET).encode("ascii")


def test_explicit_argon2id_parameters_are_encoded_in_byte_verifier(verifier):
    _, encoded = verifier
    parameters = extract_parameters(encoded.decode("ascii"))
    assert parameters == RFC_9106_LOW_MEMORY
    assert parameters.type is Type.ID
    assert (
        parameters.version,
        parameters.memory_cost,
        parameters.time_cost,
        parameters.parallelism,
        parameters.hash_len,
        parameters.salt_len,
    ) == (19, 65536, 3, 4, 32, 16)


def test_supported_default_verifier_accepts_explicit_profile_bytes(verifier):
    hasher, encoded = verifier
    assert hasher.verify(encoded, SECRET)
    assert PasswordHasher().verify(encoded, SECRET.encode("utf-8"))
    assert not hasher.check_needs_rehash(encoded)


def test_same_secret_uses_distinct_random_salts(verifier):
    hasher, encoded = verifier
    other = hasher.hash(SECRET).encode("ascii")
    assert other != encoded
    assert hasher.verify(other, SECRET)


def test_wrong_secret_refuses_with_library_mismatch(verifier):
    hasher, encoded = verifier
    with pytest.raises(VerifyMismatchError):
        hasher.verify(encoded, "wrong-synthetic-secret")


@pytest.mark.parametrize(
    "encoded,error",
    [
        (b"", InvalidHashError),
        (b"not-an-encoded-verifier", InvalidHashError),
        (b"$argon2id$invalid", VerificationError),
    ],
)
def test_malformed_verifier_refuses_with_library_error(encoded, error):
    with pytest.raises(error):
        PasswordHasher.from_parameters(RFC_9106_LOW_MEMORY).verify(encoded, SECRET)
