"""Unexposed schema acceptance on an explicitly leased local PostgreSQL instance."""

from .persistence import *

# The workspace reads whether the organisation has a committed order (apps/billing), whose rows
# reference the DPA (apps/legal) and the tenant (apps/tenancy).
INSTALLED_APPS = [*INSTALLED_APPS, "apps.workspaces", "apps.billing", "apps.legal", "apps.tenancy"]
