"""Bind collection evidence to its ledger and preserve confirmed legal history."""

from django.db import migrations

FORWARD = r'''
CREATE FUNCTION billing_dunning_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subscription uuid; current_episode uuid; prior_step text; prior_time timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dunning evidence is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (OLD.state<>'prepared' OR
   (to_jsonb(OLD)-ARRAY['state','delivered_at','receipt_at','evidence_ref','confirmed_by_id','job_id','updated_at']) IS DISTINCT FROM
   (to_jsonb(NEW)-ARRAY['state','delivered_at','receipt_at','evidence_ref','confirmed_by_id','job_id','updated_at'])) THEN
   RAISE EXCEPTION 'Dunning evidence is immutable' USING ERRCODE='23514'; END IF;
 SELECT subscription_id,episode INTO subscription,current_episode FROM billing_dunningcase WHERE id=NEW.case_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM billing_invoice WHERE id=NEW.invoice_id AND subscription_id=subscription)
 OR NEW.episode IS DISTINCT FROM current_episode THEN
   RAISE EXCEPTION 'Dunning ledger binding invalid' USING ERRCODE='23514'; END IF;
 IF NEW.state='confirmed' THEN
  IF NEW.delivered_at<NEW.created_at OR NEW.delivered_at>statement_timestamp()
   OR NEW.receipt_at>statement_timestamp() OR NEW.evidence_ref !~ '^urn:kodera:evidence:[0-9a-f-]{36}$'
   OR NOT EXISTS(SELECT 1 FROM identity_staffrole r JOIN identity_identity i ON i.id=r.identity_id
      JOIN identity_user u ON u.id=i.user_id WHERE r.identity_id=NEW.confirmed_by_id AND r.role='staff_operator'
      AND r.revoked_at IS NULL AND i.organisation_id IS NULL AND i.enabled AND i.deleted_at IS NULL
      AND u.enabled AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Dunning current staff delivery evidence required' USING ERRCODE='23514'; END IF;
  prior_step := CASE NEW.step WHEN 'reminder_2' THEN 'reminder_1' WHEN 'formal_notice' THEN 'reminder_2'
    WHEN 'suspension_notice' THEN 'formal_notice' WHEN 'suspended' THEN 'suspension_notice' WHEN 'terminated' THEN 'suspended' END;
  IF prior_step IS NOT NULL THEN
   SELECT delivered_at INTO prior_time FROM billing_dunningaction WHERE case_id=NEW.case_id
      AND episode=NEW.episode AND step=prior_step AND state='confirmed';
   IF prior_time IS NULL OR NEW.delivered_at < prior_time + (CASE WHEN NEW.step IN ('reminder_2','formal_notice') THEN interval '14 days'
       WHEN NEW.step='suspended' THEN interval '7 days' ELSE interval '0 days' END) THEN
      RAISE EXCEPTION 'Dunning ordered delivery gap required' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.step='formal_notice' AND NEW.receipt_at IS NULL THEN
   RAISE EXCEPTION 'Dunning formal receipt required' USING ERRCODE='23514'; END IF;
  IF NEW.step='terminated' AND NOT EXISTS(SELECT 1 FROM billing_dunningaction WHERE case_id=NEW.case_id
    AND episode=NEW.episode AND step='formal_notice' AND state='confirmed' AND receipt_at<=NEW.delivered_at-interval '30 days') THEN
   RAISE EXCEPTION 'Dunning formal receipt delay required' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION billing_dunning_action_guard() FROM PUBLIC;
CREATE TRIGGER billing_dunning_action_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_dunningaction
 FOR EACH ROW EXECUTE FUNCTION billing_dunning_action_guard();
CREATE FUNCTION billing_dunning_dispute_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org uuid; owed bigint; reserved bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dunning dispute evidence is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (OLD.closed_at IS NOT NULL OR
  (to_jsonb(OLD)-ARRAY['closed_at','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['closed_at','updated_at'])) THEN
  RAISE EXCEPTION 'Dunning dispute evidence is immutable' USING ERRCODE='23514'; END IF;
 SELECT organisation_id,total_incl_vat_minor-amount_paid_minor INTO org,owed FROM billing_invoice WHERE id=NEW.invoice_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM support_supportticket WHERE id=NEW.ticket_id AND organisation_id=org AND category='billing') THEN
  RAISE EXCEPTION 'Dunning dispute support binding invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT coalesce(sum(amount_minor),0) INTO reserved FROM billing_dunningdispute WHERE invoice_id=NEW.invoice_id
   AND closed_at IS NULL AND hold_until>statement_timestamp();
  IF NEW.hold_until<=statement_timestamp() OR NEW.hold_until>statement_timestamp()+interval '90 days' OR reserved+NEW.amount_minor>owed THEN
   RAISE EXCEPTION 'Dunning dispute amount or duration invalid' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION billing_dunning_dispute_guard() FROM PUBLIC;
CREATE TRIGGER billing_dunning_dispute_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_dunningdispute
 FOR EACH ROW EXECUTE FUNCTION billing_dunning_dispute_guard();
'''


class Migration(migrations.Migration):
    dependencies = [("billing", "0015_dunning_checkpoints")]
    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
migrations.RunSQL(FORWARD, '''DROP TRIGGER billing_dunning_dispute_guard ON billing_dunningdispute;
DROP FUNCTION billing_dunning_dispute_guard();
DROP TRIGGER billing_dunning_action_guard ON billing_dunningaction;
DROP FUNCTION billing_dunning_action_guard();'''),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]
