"""At most one order in flight (`placed` or `awaiting_payment`) per organisation, held by the
database.

Two placements at once for one organisation, under two keys, could each find no order in flight
and both commit: the partial unique key makes the second fail, and placeOrder answers it
`409 order-in-progress`. A paid, fulfilled or cancelled order holds nothing: the organisation's
next tenant is ordered once the first order is paid.

A database already holding two orders in flight for one organisation stops here, naming how many
organisations do, rather than failing on the index. No application path cancels an order whose
invoice is issued (BILLING_MODEL.md §4.1), so each extra order is settled by an operator: on a
disposable database (lab, a test database) recreate it; on one holding real orders, correct the
extra order's invoice first (a credit note), then set the order `cancelled`, then migrate again.
"""

from typing import Any

from django.db import migrations, models


def refuse_two_in_flight(apps: Any, schema_editor: Any) -> None:
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM (SELECT organisation_id FROM billing_order"
            " WHERE state IN ('placed', 'awaiting_payment')"
            " GROUP BY organisation_id HAVING count(*) > 1) AS doubled"
        )
        (doubled,) = cursor.fetchone()
    if doubled:
        raise RuntimeError(
            f"{doubled} organisation(s) hold more than one order in flight: an operator settles"
            " all but one of each (see this migration's docstring), then migrates again"
        )


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0005_stripe_collection'),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.RunPython(refuse_two_in_flight, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name='order',
            constraint=models.UniqueConstraint(condition=models.Q(('state__in', ['placed', 'awaiting_payment'])), fields=('organisation',), name='billing_order_one_in_flight_per_organisation'),
        ),
    ]
