from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):
    """Narrow organisation_slug_valid from 2-20 to 5-20 characters, the owner's minimum.

    The check is re-created rather than altered, so an existing slug shorter than five
    characters refuses the forward migration instead of surviving under the new rule.
    Operations run in reverse order when unapplied, so the finite lock and statement
    timeouts are set first in both directions.

    A database that holds an organisation slug of two to four characters cannot apply this
    migration: adding the check fails with "check constraint organisation_slug_valid ... is
    violated by some row". No data migration can make it applicable, because the row can be
    neither renamed nor removed. The realm must equal the slug (`organisation_realm_valid`)
    and the issuer must end with the realm (`organisation_issuer_valid`), yet the issuer is
    immutable ("Organisation issuer is immutable"); the held `SlugReservation` name is
    immutable too ("Reservation binding is immutable"), the reservation cannot be deleted
    ("Reservation is retained"), and it restricts deleting the organisation
    (`reservation_organisation_fk`). The only remedy is to rebuild that database. Nothing is
    deployed, so no such database exists outside a developer's or a test's own.
    """

    dependencies = [
        ("orgs", "0002_integrity"),
    ]

    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.RemoveConstraint(
            model_name="organisation",
            name="organisation_slug_valid",
        ),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                condition=models.Q(("slug__regex", "^[a-z0-9]([a-z0-9-]{3,18}[a-z0-9])$")),
                name="organisation_slug_valid",
            ),
        ),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]
