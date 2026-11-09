"""A minimal stand-in for Synapse's module API, so the policy runs without Synapse installed.

The real-server test (`tests/integration/`) exercises the same callbacks against a pinned Synapse.
"""

import sys
import types

NOT_SPAM = "NOT_SPAM"


class Codes:
    FORBIDDEN = "M_FORBIDDEN"


class ConfigError(Exception):
    pass


synapse = types.ModuleType("synapse")
module_api = types.ModuleType("synapse.module_api")
errors = types.ModuleType("synapse.module_api.errors")
module_api.NOT_SPAM = NOT_SPAM
module_api.ModuleApi = object
errors.Codes = Codes
errors.ConfigError = ConfigError
sys.modules.setdefault("synapse", synapse)
sys.modules.setdefault("synapse.module_api", module_api)
sys.modules.setdefault("synapse.module_api.errors", errors)
