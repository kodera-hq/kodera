"""Protected moderation targets; organisation roles never imply a weaker target boundary."""

ADMINS = frozenset({"org_owner", "org_admin"})


def target_allowed(actor_role: str, target_role: str, action: str) -> bool:
    return target_role not in ADMINS or (action == "unban" and actor_role in ADMINS)
