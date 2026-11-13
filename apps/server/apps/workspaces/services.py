"""Public workspace service ports; policy construction performs no request or database work."""

from core.api.guarded_replay import EffectPolicy


def quota_replay_policy() -> EffectPolicy:
    from .quota_http import QuotaReplayPolicy

    return QuotaReplayPolicy()
