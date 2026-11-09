"""Registration of the job queue: jobs, steps, lock reservations, dispatches and decisions."""

from django.apps import AppConfig


class JobsConfig(AppConfig):
    name = "apps.jobs"
    label = "jobs"

    def ready(self) -> None:
        from apps.jobs import mutants

        # A mis-set mutant flag configuration fails at start-up, not at the first guard it reaches.
        mutants.active()
