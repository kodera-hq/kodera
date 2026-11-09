#!/usr/bin/env python3
"""Fixed directory image qualification; runtime requires exact external admission."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dev.accept_customer_http import ControllerError, main  # noqa: E402
from dev.membership_directory_image_acceptance import DirectoryScenario  # noqa: E402


def entrypoint():
    parser = argparse.ArgumentParser()
    parser.add_argument("--admission", type=Path, required=True)
    args = parser.parse_args()
    main(DirectoryScenario(args.admission))


if __name__ == "__main__":
    try:
        entrypoint()
    except ControllerError as error:
        print(json.dumps({"result": "refused", "reason": str(error)}), file=sys.stderr)
        raise SystemExit(1) from None
    except Exception:
        print(
            json.dumps({"result": "refused", "reason": "directory-controller-failed"}),
            file=sys.stderr,
        )
        raise SystemExit(1) from None
