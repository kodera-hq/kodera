#!/usr/bin/env python3
"""Fail if an operation's `x-kodera-authz` grants a role its matrix cell does not hold.

`docs/api/AUTHZ.md` §5 is the source of truth for who may touch what: one row
per resource, one column per role, one cell of grants. §5 and §10 say that an
operation's `x-kodera-authz` carries "the roles that hold that cell, taken from
the same row". Until this check existed nothing compared the two, and the
contract drifted to thirteen operations granting a role the matrix never gave
it. A grant that lives only in the contract is privilege nobody reviewed.

The assertion is one-directional on purpose. An operation may be NARROWER than
its resource-level cell — `listOrganisations` is the fleet-wide list, so it is
staff-only even though every tenant role may read its own organisation. It may
never be WIDER: a role the cell does not hold is refused, naming the file, the
line, the operation and both role lists.

Three declared exceptions, all stated in AUTHZ.md and all verified here rather
than assumed:

- `anonymous` has no column. It reaches the rows §5 lists under the matrix as
  whole rows, and, by operation id, the two operations that rule names on rows
  that are otherwise authenticated; an operation declaring it anywhere else is
  refused.
- `invited` has no column and reaches two operations, `acceptInvitation` and
  its read-only preview `previewInvitation`, whose exact role set is an
  override stated in §4. The override is keyed by
  operation id, never by widening a cell, and the check refuses if the sentence
  that states it disappears from AUTHZ.md.
- `bootstrap` has no column and reaches exactly two operations, the bootstrap
  status read and the owner-claim consume, listed here and stated in §4 by a
  sentence the check looks for. An operation declaring it anywhere else is
  refused by name, and so is every operation declaring it if the sentence is
  gone. `consumeOwnerClaim` is additionally an override, for the same reason
  `acceptInvitation` is: it names `org_owner` so a replay by the person who has
  just become owner is answered rather than refused.

Parsing never skips: a matrix row the scanner cannot read, an unknown grant
phrase in a cell, an operation without both extensions, and a role that is not
a column are each a refusal, because a silently ignored input is how a check
reports coverage it does not have.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import yaml

AUTHZ_DEFAULT = "docs/api/AUTHZ.md"
CONTRACT_DEFAULT = "contracts/core-api.openapi.yaml"

CLOSED_VERBS = frozenset(
    {"read", "create", "update", "delete", "act", "export", "rotate", "report"}
)
FULL = frozenset({"create", "read", "update", "delete", "act"})

# Every phrase that may appear in a cell, and the verbs of the closed set it
# grants ON THIS RESOURCE. A phrase that names a grant on a different resource,
# or that the rules under the matrix explicitly override, maps to the empty set
# and says why. A phrase absent from this table is refused, never ignored.
PHRASES: dict[str, frozenset[str]] = {
    "full": FULL,
    "read": frozenset({"read"}),
    "create": frozenset({"create"}),
    "update": frozenset({"update"}),
    "delete": frozenset({"delete"}),
    "act": frozenset({"act"}),
    "revoke": frozenset({"delete"}),
    "update role": frozenset({"update"}),
    "reply": frozenset({"update"}),
    "create link": frozenset({"create"}),
    "export": frozenset({"export"}),
    "rotate": frozenset({"rotate"}),
    "report": frozenset({"report"}),
    "request": frozenset({"create"}),
    "issue credit note": frozenset({"create"}),
    "reconcile": frozenset({"act"}),
    "deprecate": frozenset({"update"}),
    # AUTHZ.md §5, second rule under the matrix: at launch every tenant job
    # kind is staff_operator-only and the tenant-side request creates a
    # SupportTicketLink instead, so "request action" grants no verb here.
    "request action": frozenset(),
    "request restore": frozenset(),
    "request change": frozenset(),
    # Names a grant on the Order row, not a verb on Tenant.
    "order": frozenset(),
    # AUTHZ.md §5, first rule under the matrix: the agent pulls over its own
    # channel; this is not a Core API operation.
    "pull": frozenset(),
}

# Scope words a cell may carry; they qualify the row set, not the verb.
SCOPE_WORDS = frozenset({"own", "all", "self", "by reference"})

# AUTHZ.md §5, fourth rule under the matrix: these three principals have no
# column on purpose. Their authorisation is the closed list in that paragraph
# (anonymous), the override below (invited) or the closed operation list below
# (bootstrap), not a cell.
NO_COLUMN = frozenset({"anonymous", "invited", "bootstrap"})

# AUTHZ.md §4: the `bootstrap` principal reaches exactly these operations. The
# sentence is checked so that this list cannot outlive the rule that states it;
# if the sentence goes, every operation naming `bootstrap` is refused.
BOOTSTRAP_OPERATIONS = frozenset({"getOrganisationBootstrap", "consumeOwnerClaim"})
BOOTSTRAP_SENTENCE = (
    "`bootstrap` reaches exactly two operations, `getOrganisationBootstrap` and `consumeOwnerClaim`"
)

# The rows that same rule lets `anonymous` reach as whole rows: the rows
# MODEL.md declares global, and the status page.
ANONYMOUS_RESOURCES = frozenset(
    {
        "plan",
        "pack",
        "capacity_tier",
        "price",
        "legal_document",
        "incident",
        "probe",
        "status_component",
    }
)

# The two operations the same rule names one by one: realm discovery and the
# sign-in problem report. The contract scopes them to the organisation and
# support-ticket rows, which every other operation reaches authenticated, so
# the allowance is keyed by operation id and never widens the row.
ANONYMOUS_OPERATIONS = frozenset(
    {
        "discoverRealm",
        "reportSignInProblem",
        "requestPassportMagicLink",
        "verifyPassportMagicLink",
        "receiveStripeWebhook",
    }
)

# AUTHZ.md §5 and §7: the agent is a separate authenticator with no scope on
# any Core API resource, so its column is exercised through
# agent-api.openapi.yaml and never expected on a Core operation.
NOT_ON_CORE = frozenset({"agent"})

# Operations whose role set is stated in AUTHZ.md prose as an override of the
# matrix rather than as a cell. Each entry names the exact roles the contract
# must carry and every sentence in AUTHZ.md that grants them together; if any
# of them is gone, the override is gone with it and the operation is refused.
# The preview needs two: the one naming it in the `invited` row, and the one
# granting both invitation operations the four organisation roles.
INVITATION_ROLES_SENTENCE = "Both operations also name the four organisation roles, deliberately"
OVERRIDES: dict[str, tuple[frozenset[str], tuple[str, ...]]] = {
    "acceptInvitation": (
        frozenset({"invited", "org_owner", "org_admin", "org_billing", "org_member"}),
        (INVITATION_ROLES_SENTENCE,),
    ),
    "previewInvitation": (
        frozenset({"invited", "org_owner", "org_admin", "org_billing", "org_member"}),
        (
            "`POST /invitations/preview`, the read-only card shown before it from the same token",
            INVITATION_ROLES_SENTENCE,
        ),
    ),
    "consumeOwnerClaim": (
        frozenset({"bootstrap", "org_owner"}),
        ("That operation also names `org_owner`, deliberately",),
    ),
}


class RefusalError(Exception):
    """An input this check will not guess about."""


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def parse_cell(cell: str, where: str) -> frozenset[str]:
    """A cell is a comma-separated list of grants. Return the verbs it grants."""
    cell = cell.strip()
    if cell in {"", "—", "-"}:
        return frozenset()
    cell = re.sub(r"\([^)]*\)", " ", cell)  # "(never read)", "(members and admins only)"
    verbs: set[str] = set()
    for grant in cell.split(","):
        words = grant.split()
        while words and " ".join(words[-2:]) in SCOPE_WORDS:
            words = words[:-2]
        while words and words[-1] in SCOPE_WORDS:
            words = words[:-1]
        phrase = " ".join(words).strip()
        if not phrase:
            continue
        if phrase not in PHRASES:
            raise RefusalError(
                f"{where}: unknown grant phrase {phrase!r} in cell {cell.strip()!r}; "
                "add it to PHRASES with the verbs it grants, or fix the matrix"
            )
        verbs |= PHRASES[phrase]
    return frozenset(verbs)


class Matrix:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.text = path.read_text(encoding="utf-8")
        self.roles: list[str] = []
        self.cells: dict[str, dict[str, frozenset[str]]] = {}
        self.line: dict[str, int] = {}
        self._parse()

    def _parse(self) -> None:
        lines = self.text.splitlines()
        try:
            start = next(i for i, ln in enumerate(lines) if ln.startswith("## 5. "))
            end = next(
                i
                for i, ln in enumerate(lines[start:], start)
                if ln.startswith("Rules that override")
            )
        except StopIteration as exc:
            raise RefusalError(
                f"{self.path}: could not find the §5 matrix between its heading and its rules"
            ) from exc

        rows = [(i + 1, ln) for i, ln in enumerate(lines[start:end], start) if ln.startswith("|")]
        if len(rows) < 3:
            raise RefusalError(f"{self.path}: §5 has no matrix rows")

        header = [c.strip().strip("`") for c in rows[0][1].strip().strip("|").split("|")]
        self.roles = header[1:]
        width = len(header)

        for number, row in rows[2:]:
            cells = [c.strip() for c in row.strip().strip("|").split("|")]
            # A row the scanner cannot read is refused, never skipped: a
            # skipped row is a resource every operation may then claim freely.
            if len(cells) != width:
                raise RefusalError(
                    f"{self.path}:{number}: cannot read this matrix row "
                    f"({len(cells)} cells, header has {width}): {row.strip()}"
                )
            names = [c.strip().strip("`") for c in cells[0].split(",")]
            for name in names:
                resource = snake(name)
                if resource in self.cells:
                    raise RefusalError(
                        f"{self.path}:{number}: resource `{resource}` appears twice in §5"
                    )
                self.line[resource] = number
                self.cells[resource] = {
                    role: parse_cell(cell, f"{self.path}:{number} column `{role}`")
                    for role, cell in zip(self.roles, cells[1:], strict=True)
                }

    def holders(self, resource: str, verb: str) -> frozenset[str]:
        return frozenset(r for r in self.roles if verb in self.cells[resource][r])

    def states(self, sentence: str) -> bool:
        return sentence in self.text


def parse_operations(path: Path) -> list[tuple[str, str, str | None, list[str] | None]]:
    text = path.read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    methods = {"get", "put", "post", "delete", "patch", "options", "head", "trace"}
    ops = []
    for route, item in (doc.get("paths") or {}).items():
        for method, op in (item or {}).items():
            if method in methods and isinstance(op, dict):
                authz = op.get("x-kodera-authz")
                roles = authz.get("roles") if isinstance(authz, dict) else None
                ops.append(
                    (
                        op.get("operationId") or f"{method.upper()} {route}",
                        f"{method.upper()} {route}",
                        op.get("x-kodera-scope"),
                        roles,
                    )
                )
    # The YAML walk above only sees operations under a method key. The count of
    # `operationId:` lines in the file is the independent witness that it saw
    # them all; a disagreement is refused rather than reported as coverage.
    declared = len(re.findall(r"^\s+operationId:\s*\S+", text, flags=re.MULTILINE))
    if declared != len(ops):
        raise RefusalError(
            f"{path}: found {len(ops)} operations under method keys but "
            f"{declared} `operationId:` lines; an operation is not where this check looks"
        )
    ops.sort(key=lambda o: (str(o[2]), o[0]))
    return ops


def check(matrix: Matrix, contract: Path) -> list[str]:
    ops = parse_operations(contract)
    where = f"{matrix.path}"
    failures: list[str] = []

    for oid, route, scope, roles in ops:
        if not scope:
            failures.append(f"{oid} ({route}): no x-kodera-scope")
            continue
        if roles is None:
            failures.append(f"{oid} ({route}): no x-kodera-authz.roles")
            continue
        if scope.count(":") != 1:
            failures.append(f"{oid} ({route}): scope {scope!r} is not <resource>:<verb>")
            continue
        resource, verb = scope.split(":")
        if resource not in matrix.cells:
            failures.append(
                f"{oid} ({route}): scope resource {resource!r} is not a row of {where} §5"
            )
            continue
        if verb not in CLOSED_VERBS:
            failures.append(
                f"{oid} ({route}): scope verb {verb!r} is not in the closed set of {where} §5"
            )
            continue

        declared = frozenset(roles)
        unknown = declared - set(matrix.roles) - NO_COLUMN
        if unknown:
            failures.append(
                f"{oid} ({route}): x-kodera-authz names {sorted(unknown)}, not a column of {where} §5"
            )
            continue

        if "bootstrap" in declared:
            if oid not in BOOTSTRAP_OPERATIONS:
                failures.append(
                    f"{oid} ({route}): names `bootstrap`, which {where} §4 grants to "
                    f"{sorted(BOOTSTRAP_OPERATIONS)} only"
                )
                continue
            if not matrix.states(BOOTSTRAP_SENTENCE):
                failures.append(
                    f"{oid} ({route}): names `bootstrap`, but {where} §4 no longer states "
                    f"the sentence {BOOTSTRAP_SENTENCE!r}"
                )
                continue

        if oid in OVERRIDES:
            expected, sentences = OVERRIDES[oid]
            missing = [sentence for sentence in sentences if not matrix.states(sentence)]
            if missing:
                failures.append(
                    f"{oid} ({route}): its override is not stated in {where} §4 "
                    f"(missing the sentence {missing[0]!r}); the contract has {sorted(declared)}"
                )
            elif declared != expected:
                failures.append(
                    f"{oid} ({route}): override in {where} §4 grants {sorted(expected)}, "
                    f"contract has {sorted(declared)}"
                )
            continue

        if "invited" in declared:
            failures.append(
                f"{oid} ({route}): names `invited`, which {where} §4 grants to acceptInvitation and previewInvitation only"
            )
            continue
        if (
            "anonymous" in declared
            and resource not in ANONYMOUS_RESOURCES
            and oid not in ANONYMOUS_OPERATIONS
        ):
            failures.append(
                f"{oid} ({route}): names `anonymous` on `{resource}`, which the rule under "
                f"{where} §5 does not list among the resources anonymous may reach, and "
                f"{oid} is not one of the operations it names ({sorted(ANONYMOUS_OPERATIONS)})"
            )
            continue

        actual = declared - NO_COLUMN - NOT_ON_CORE
        expected = matrix.holders(resource, verb) - NOT_ON_CORE
        extra = sorted(actual - expected)
        if extra:
            failures.append(
                f"{oid} ({route}) scope {scope}: grants {extra} beyond its cell "
                f"[{where}:{matrix.line[resource]} row `{resource}` verb `{verb}` "
                f"holds {sorted(expected)}, contract has {sorted(actual)}]"
            )

    print(f"checked {len(ops)} operations against {len(matrix.cells)} matrix rows in {where}")
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--authz", default=AUTHZ_DEFAULT, type=Path)
    parser.add_argument("--contract", default=CONTRACT_DEFAULT, type=Path)
    args = parser.parse_args(argv)

    try:
        matrix = Matrix(args.authz)
        failures = check(matrix, args.contract)
    except RefusalError as exc:
        print(f"::error::{exc}")
        print(f"FAIL {exc}")
        return 1

    if failures:
        print(f"FAIL {len(failures)} operation(s) disagree with {args.authz} §5:")
        for failure in failures:
            print(f"  - {failure}")
            print(f"::error file={args.contract}::{failure}")
        return 1
    print(f"PASS no operation grants a role its {args.authz} §5 cell does not hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
