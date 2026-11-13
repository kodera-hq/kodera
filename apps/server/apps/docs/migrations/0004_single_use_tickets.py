"""Redeem tickets atomically across processes and service restarts."""

from django.db import migrations, models

FORWARD = r'''
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION docs_redeem_collaboration_ticket(p_nonce uuid, p_expires bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
SET lock_timeout = '3s' SET statement_timeout = '5s' AS $$
DECLARE now_seconds bigint := floor(extract(epoch FROM clock_timestamp())); accepted integer;
BEGIN
  IF p_nonce IS NULL OR p_expires IS NULL OR p_expires <= now_seconds
     OR p_expires > now_seconds + 305 THEN RETURN false; END IF;
  DELETE FROM public.docs_collaborationticket WHERE nonce IN
    (SELECT nonce FROM public.docs_collaborationticket WHERE expires <= now_seconds
     ORDER BY expires LIMIT 128);
  INSERT INTO public.docs_collaborationticket(nonce, expires) VALUES(p_nonce, p_expires)
    ON CONFLICT(nonce) DO NOTHING;
  GET DIAGNOSTICS accepted = ROW_COUNT;
  RETURN accepted = 1;
END $$;
REVOKE ALL ON FUNCTION docs_redeem_collaboration_ticket(uuid,bigint) FROM PUBLIC;
'''


class Migration(migrations.Migration):
    dependencies = [('docs', '0003_collaboration_boundary')]
    operations = [
        migrations.RunSQL("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';", migrations.RunSQL.noop),
        migrations.CreateModel(
            name='CollaborationTicket',
            fields=[
                ('nonce', models.UUIDField(primary_key=True, serialize=False)),
                ('expires', models.BigIntegerField(db_index=True)),
            ],
        ),
        migrations.RunSQL(
            FORWARD, 'DROP FUNCTION docs_redeem_collaboration_ticket(uuid,bigint);'
        ),
    ]
