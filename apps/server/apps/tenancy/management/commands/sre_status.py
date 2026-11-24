"""Single-screen centralized SRE, WarmPool, FinOps and internal SLO status (`manage.py sre_status`).

Guarded strictly by `require_operator_profile()` and excluded from the customer API image.
"""

from __future__ import annotations

import json
from typing import Any, cast

from django.core.management.base import BaseCommand, CommandParser

from apps.orgs.management.operator import require_operator_profile


class Command(BaseCommand):
    help = "Print centralized SRE queue, Sovereign WarmPool, FinOps tier and internal SLO summary."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--json",
            action="store_true",
            dest="as_json",
            help="Emit machine-readable JSON snapshot.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        require_operator_profile()
        from core.staff_api.services import collect_sre_summary

        snapshot = cast(dict[str, Any], collect_sre_summary(staff_identity_id=None))
        if options.get("as_json"):
            self.stdout.write(json.dumps(snapshot, sort_keys=True))
            return

        slo = cast(dict[str, Any], snapshot["slo_indicators"])
        wp = cast(dict[str, Any], snapshot["warm_pool"])
        finops = cast(dict[str, Any], snapshot["finops_guard"])
        tiers = cast(dict[str, Any], finops["sovereign_tiers"])
        jobs = cast(dict[str, Any], snapshot["jobs"])["status_counts"]
        outbox = cast(dict[str, Any], snapshot["outbox"])["status_counts"]

        lines = [
            f"SRE STATUS: {slo['status']}",
            (
                f"SLO INDICATORS: stale_agents={slo['stale_agents_count']} "
                f"stuck_jobs={slo['stuck_jobs_count']} "
                f"outbox_lag_s={slo['outbox_lag_seconds']} "
                f"unpaid_overdue_orders={slo['unpaid_overdue_orders_count']}"
            ),
            (
                f"WARM POOL (max_total={wp['max_total']}): "
                f"ready={wp['ready']} provisioning={wp['provisioning']} "
                f"claimed={wp['claimed']} unhealthy={wp['unhealthy']}"
            ),
            (
                f"FINOPS GUARD (floor_bps={finops['min_margin_bps_floor']}): "
                f"PRO2-S={tiers['PRO2-S']} PRO2-M={tiers['PRO2-M']} PRO2-L={tiers['PRO2-L']}"
            ),
            f"JOBS: {json.dumps(jobs, sort_keys=True)}",
            f"OUTBOX: {json.dumps(outbox, sort_keys=True)}",
        ]
        self.stdout.write("\n".join(lines))
