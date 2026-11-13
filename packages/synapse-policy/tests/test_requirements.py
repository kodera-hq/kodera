"""Keep the local test runner outside known vulnerable temporary-directory releases."""

import pathlib
import re

try:
    import tomllib
except ModuleNotFoundError:  # pytest supplies the backport on Python 3.10.
    import tomli as tomllib

import pytest
from packaging.requirements import Requirement
from packaging.version import Version

ROOT = pathlib.Path(__file__).resolve().parent.parent
MINIMUM_SAFE_PYTEST = Version("9.0.3")


def safe_pytest_pin(requirements: str) -> Version:
    pins = re.findall(r"^pytest==([^\s\\]+)", requirements, flags=re.MULTILINE)
    assert len(pins) == 1, "test requirements must contain exactly one pytest pin"
    version = Version(pins[0])
    assert version >= MINIMUM_SAFE_PYTEST, "pytest pin includes CVE-2025-71176 temporary-directory vulnerability"
    return version


def test_test_requirements_pin_a_patched_pytest_release():
    source = safe_pytest_pin((ROOT / "requirements-test.in").read_text())
    locked = safe_pytest_pin((ROOT / "requirements-test.txt").read_text())
    assert source == locked, "pytest input and hash lock must agree"


@pytest.mark.parametrize("version", ["8.4.2", "9.0.2", "9.0.3rc1"])
def test_vulnerable_test_runner_pin_mutations_are_refused(version):
    with pytest.raises(AssertionError, match="CVE-2025-71176"):
        safe_pytest_pin(f"pytest=={version}\n")


@pytest.mark.parametrize("version", ["9.0.3", "9.1.1"])
def test_patched_test_runner_pins_are_admitted(version):
    assert safe_pytest_pin(f"pytest=={version}\n") == Version(version)


def test_optional_test_extra_excludes_vulnerable_pytest_releases():
    metadata = tomllib.loads((ROOT / "pyproject.toml").read_text())
    runners = [Requirement(value) for value in metadata["project"]["optional-dependencies"]["test"] if Requirement(value).name == "pytest"]
    assert len(runners) == 1, "test extra must name exactly one pytest requirement"
    assert any(bound.operator == ">=" and Version(bound.version) >= MINIMUM_SAFE_PYTEST for bound in runners[0].specifier), "test extra must declare a pytest minimum patched for CVE-2025-71176"
    assert runners[0].specifier.contains(str(safe_pytest_pin((ROOT / "requirements-test.in").read_text())))
