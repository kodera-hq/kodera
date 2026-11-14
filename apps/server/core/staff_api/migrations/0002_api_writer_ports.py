"""Narrow SECURITY DEFINER ports so `kodera_api` serves `/staff/v1/*` without excess table grants."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION staff_fence_caller(
  p_identity_id uuid,
  p_user_id uuid,
  p_issuer text,
  p_subject text,
  p_allowed_roles text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  v_role text;
  v_roles text[] := ARRAY[]::text[];
BEGIN
  IF p_identity_id IS NULL
     OR p_user_id IS NULL
     OR coalesce(p_issuer, '') = ''
     OR coalesce(p_subject, '') = ''
     OR p_allowed_roles IS NULL
     OR coalesce(array_length(p_allowed_roles, 1), 0) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'staff_identity_missing');
  END IF;

  PERFORM 1
    FROM public.identity_user u
    WHERE u.id = p_user_id
      AND u.enabled = TRUE
      AND u.deleted_at IS NULL
    FOR SHARE OF u;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'staff_identity_missing');
  END IF;

  PERFORM 1
    FROM public.identity_identity i
    WHERE i.id = p_identity_id
      AND i.user_id = p_user_id
      AND i.organisation_id IS NULL
      AND i.realm = 'kodera-staff'
      AND i.issuer = p_issuer
      AND i.subject = p_subject
      AND i.enabled = TRUE
      AND i.deleted_at IS NULL
    FOR SHARE OF i;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'staff_identity_missing');
  END IF;

  FOR v_role IN
    SELECT g.role
      FROM public.staff_api_role_grant g
      WHERE g.identity_id = p_identity_id
        AND g.realm = 'kodera-staff'
        AND g.revoked_at IS NULL
      ORDER BY g.id
      FOR SHARE OF g
  LOOP
    IF NOT (v_role = ANY(v_roles)) THEN
      v_roles := array_append(v_roles, v_role);
    END IF;
  END LOOP;

  FOR v_role IN
    SELECT r.role
      FROM public.identity_staffrole r
      WHERE r.identity_id = p_identity_id
        AND r.realm = 'kodera-staff'
        AND r.revoked_at IS NULL
      ORDER BY r.id
      FOR SHARE OF r
  LOOP
    IF NOT (v_role = ANY(v_roles)) THEN
      v_roles := array_append(v_roles, v_role);
    END IF;
  END LOOP;

  IF NOT (v_roles && p_allowed_roles) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_staff_role');
  END IF;

  RETURN jsonb_build_object('ok', true, 'roles', to_jsonb(v_roles));
END $$;
REVOKE ALL ON FUNCTION staff_fence_caller(uuid, uuid, text, text, text[]) FROM PUBLIC;

CREATE FUNCTION staff_read_outbox_sre_summary(p_actor_identity uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF p_actor_identity IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.identity_identity i
    JOIN public.identity_user u ON u.id = i.user_id
    WHERE i.id = p_actor_identity
      AND i.organisation_id IS NULL
      AND i.realm = 'kodera-staff'
      AND i.enabled = TRUE
      AND i.deleted_at IS NULL
      AND u.enabled = TRUE
      AND u.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.staff_api_role_grant g
          WHERE g.identity_id = i.id
            AND g.realm = 'kodera-staff'
            AND g.revoked_at IS NULL
            AND g.role IN ('staff_owner', 'staff_operator', 'staff_security', 'staff_backend')
        )
        OR EXISTS (
          SELECT 1 FROM public.identity_staffrole r
          WHERE r.identity_id = i.id
            AND r.realm = 'kodera-staff'
            AND r.revoked_at IS NULL
            AND r.role IN ('staff_owner', 'staff_operator', 'staff_security', 'staff_backend')
        )
      )
  ) THEN
    RAISE EXCEPTION 'staff outbox summary refused' USING ERRCODE = '42501';
  END IF;

  IF to_regclass('public.outbox_outboxdelivery') IS NULL THEN
    RETURN jsonb_build_object('status_counts', v_counts, 'reconciling_deliveries', v_rows);
  END IF;

  SELECT coalesce(jsonb_object_agg(s.status, s.cnt), '{}'::jsonb)
    INTO v_counts
    FROM (SELECT status, count(*)::bigint AS cnt FROM public.outbox_outboxdelivery GROUP BY status) s;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', d.id::text,
        'organisation_id', d.organisation_id::text,
        'category', d.category,
        'changes_realm', d.changes_realm,
        'status', d.status,
        'operation_ref', d.operation_ref,
        'started_at', d.started_at,
        'created_at', d.created_at
      )
    ),
    '[]'::jsonb
  )
    INTO v_rows
    FROM (
      SELECT id, organisation_id, category, changes_realm, status, operation_ref, started_at, created_at
      FROM public.outbox_outboxdelivery
      WHERE status = 'needs_reconciliation'
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    ) d;

  RETURN jsonb_build_object('status_counts', v_counts, 'reconciling_deliveries', v_rows);
END $$;
REVOKE ALL ON FUNCTION staff_read_outbox_sre_summary(uuid) FROM PUBLIC;

CREATE FUNCTION staff_sync_identity_bridge_role(
  p_actor_identity uuid,
  p_target_identity uuid,
  p_role text,
  p_action text,
  p_bridge_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  v_remaining bigint;
  v_existing uuid;
  v_actor_authorized boolean := FALSE;
BEGIN
  IF p_actor_identity IS NULL
     OR p_target_identity IS NULL
     OR p_actor_identity = p_target_identity
     OR p_role IS NULL
     OR p_role NOT IN ('staff_operator', 'staff_support', 'staff_security')
     OR p_action IS NULL
     OR p_action NOT IN ('grant', 'revoke') THEN
    RAISE EXCEPTION 'staff bridge role sync refused' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.identity_user u
    JOIN public.identity_identity i ON i.user_id = u.id
    WHERE i.id = p_actor_identity
      AND i.organisation_id IS NULL
      AND i.realm = 'kodera-staff'
      AND i.enabled = TRUE
      AND i.deleted_at IS NULL
      AND u.enabled = TRUE
      AND u.deleted_at IS NULL
    FOR SHARE OF u, i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff bridge actor unauthorized' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.staff_api_role_grant g
    WHERE g.identity_id = p_actor_identity
      AND g.realm = 'kodera-staff'
      AND g.revoked_at IS NULL
      AND g.role IN ('staff_owner', 'staff_operator')
    ORDER BY g.id
    LIMIT 1
    FOR SHARE OF g;
  IF FOUND THEN
    v_actor_authorized := TRUE;
  END IF;

  PERFORM 1
    FROM public.identity_staffrole r
    WHERE r.identity_id = p_actor_identity
      AND r.realm = 'kodera-staff'
      AND r.revoked_at IS NULL
      AND r.role IN ('staff_owner', 'staff_operator')
    ORDER BY r.id
    LIMIT 1
    FOR SHARE OF r;
  IF FOUND THEN
    v_actor_authorized := TRUE;
  END IF;

  IF NOT v_actor_authorized THEN
    RAISE EXCEPTION 'staff bridge actor unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'grant' THEN
    IF p_bridge_id IS NULL THEN
      RAISE EXCEPTION 'staff bridge grant id required' USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.identity_user u
      JOIN public.identity_identity i ON i.user_id = u.id
      WHERE i.id = p_target_identity
        AND i.organisation_id IS NULL
        AND i.realm = 'kodera-staff'
        AND i.enabled = TRUE
        AND i.deleted_at IS NULL
        AND u.enabled = TRUE
        AND u.deleted_at IS NULL
      FOR SHARE OF u, i;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'staff bridge target disabled or missing' USING ERRCODE = '23514';
    END IF;

    SELECT id INTO v_existing
      FROM public.identity_staffrole
      WHERE identity_id = p_target_identity
        AND realm = 'kodera-staff'
        AND role = p_role
        AND revoked_at IS NULL
      LIMIT 1
      FOR UPDATE;
    IF v_existing IS NOT NULL THEN
      RETURN FALSE;
    END IF;

    INSERT INTO public.identity_staffrole (
      id, created_at, updated_at, identity_id, realm, role, revoked_at
    ) VALUES (
      p_bridge_id, clock_timestamp(), clock_timestamp(), p_target_identity, 'kodera-staff', p_role, NULL
    );
    RETURN TRUE;
  END IF;

  IF p_role = 'staff_operator' THEN
    SELECT count(DISTINCT h.identity_id) INTO v_remaining
      FROM (
        SELECT identity_id FROM public.staff_api_role_grant
        WHERE realm = 'kodera-staff' AND role = 'staff_operator' AND revoked_at IS NULL
        UNION
        SELECT identity_id FROM public.identity_staffrole
        WHERE realm = 'kodera-staff' AND role = 'staff_operator' AND revoked_at IS NULL
      ) h
      JOIN public.identity_identity i ON i.id = h.identity_id
      JOIN public.identity_user u ON u.id = i.user_id
      WHERE h.identity_id <> p_target_identity
        AND i.realm = 'kodera-staff'
        AND i.enabled = TRUE
        AND i.deleted_at IS NULL
        AND u.enabled = TRUE
        AND u.deleted_at IS NULL;
    IF coalesce(v_remaining, 0) < 2 THEN
      RAISE EXCEPTION 'staff operator floor refused' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.identity_staffrole
    SET revoked_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE identity_id = p_target_identity
      AND realm = 'kodera-staff'
      AND role = p_role
      AND revoked_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION staff_sync_identity_bridge_role(uuid, uuid, text, text, uuid) FROM PUBLIC;

CREATE FUNCTION staff_reconcile_job(
  p_actor_identity uuid,
  p_job_id uuid,
  p_decision jsonb,
  p_request_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  v_decision_id uuid;
  v_decision_audit_id uuid;
  v_step_audit_id uuid;
  v_exit text;
  v_outcome text;
  v_c_provider text;
  v_c_resource text;
  v_c_request text;
  v_c_observed timestamptz;
  v_t_provider text;
  v_t_resource text;
  v_t_request text;
  v_t_observed timestamptz;
  v_status text;
  v_organisation_id uuid;
  v_parent_job_id uuid;
  v_unresolved_step_id uuid;
  v_unresolved_op_ref text;
  v_decided_at timestamptz;
  v_dispatch_id uuid;
  v_dispatched_at timestamptz;
  v_closed_outcome text;
  v_grant_id uuid;
  v_closes_with text;
  v_step_next_status text;
  v_step_seq integer;
  v_step_output_ref text;
  v_new_status text;
  v_org_slug text;
BEGIN
  IF p_actor_identity IS NULL OR p_job_id IS NULL OR p_decision IS NULL
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{8,64}$' THEN
    RAISE EXCEPTION 'staff job reconciliation input refused' USING ERRCODE = '23514';
  END IF;

  v_decision_id := (p_decision->>'decision_id')::uuid;
  v_decision_audit_id := (p_decision->>'decision_audit_id')::uuid;
  v_step_audit_id := (p_decision->>'step_audit_id')::uuid;
  v_exit := p_decision->>'exit';
  v_outcome := p_decision->>'operation_outcome';
  v_c_provider := p_decision->>'c_provider';
  v_c_resource := p_decision->>'c_resource_id';
  v_c_request := p_decision->>'c_request_id';
  v_c_observed := (p_decision->>'c_observed_at')::timestamptz;
  v_t_provider := p_decision->>'t_provider';
  v_t_resource := p_decision->>'t_resource_id';
  v_t_request := p_decision->>'t_request_id';
  v_t_observed := (p_decision->>'t_observed_at')::timestamptz;

  IF v_decision_id IS NULL OR v_decision_audit_id IS NULL OR v_step_audit_id IS NULL
     OR v_exit NOT IN ('resume', 'fail')
     OR v_outcome NOT IN ('completed', 'no_effect', 'partial') THEN
    RAISE EXCEPTION 'staff job reconciliation payload refused' USING ERRCODE = '23514';
  END IF;

  SELECT j.status, j.organisation_id, j.parent_job_id, j.unresolved_step_id, j.unresolved_operation_ref
    INTO v_status, v_organisation_id, v_parent_job_id, v_unresolved_step_id, v_unresolved_op_ref
    FROM public.jobs_job j
    WHERE j.id = p_job_id
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_found');
  END IF;

  IF v_status <> 'needs_reconciliation' OR v_unresolved_step_id IS NULL OR v_unresolved_op_ref IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_in_reconciliation');
  END IF;

  v_decided_at := clock_timestamp();

  IF EXISTS (
    SELECT 1 FROM public.jobs_job s
    WHERE s.parent_job_id = p_job_id AND s.status NOT IN ('succeeded', 'failed', 'cancelled')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sub_job_not_terminal');
  END IF;

  SELECT d.id, d.dispatched_at, d.terminal_outcome
    INTO v_dispatch_id, v_dispatched_at, v_closed_outcome
    FROM public.jobs_jobdispatch d
    WHERE d.job_id = p_job_id
      AND d.step_id = v_unresolved_step_id
      AND d.operation_ref = v_unresolved_op_ref
    ORDER BY d.dispatched_at DESC, d.id DESC
    LIMIT 1;

  SELECT r.id INTO v_grant_id
    FROM public.identity_staffrole r
    JOIN public.identity_identity i ON i.id = r.identity_id
    JOIN public.identity_user u ON u.id = i.user_id
    WHERE r.identity_id = p_actor_identity
      AND r.realm = 'kodera-staff'
      AND r.role = 'staff_operator'
      AND r.revoked_at IS NULL
      AND i.deleted_at IS NULL
      AND i.enabled = TRUE
      AND u.deleted_at IS NULL
      AND u.enabled = TRUE
    ORDER BY r.created_at, r.id
    LIMIT 1
    FOR SHARE OF r, i, u;
  IF v_grant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'role_missing');
  END IF;

  IF v_dispatched_at IS NOT NULL AND NOT (v_dispatched_at - interval '5 minutes' < v_c_observed) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'evidence_out_of_order_compute');
  END IF;
  IF NOT (v_c_observed <= v_t_observed) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'evidence_out_of_order_target');
  END IF;
  IF NOT (v_t_observed <= v_decided_at + interval '5 minutes') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'evidence_out_of_order_future');
  END IF;
  IF v_outcome = 'partial' AND v_exit = 'resume' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'partial_resume');
  END IF;

  v_closes_with := CASE v_outcome
    WHEN 'completed' THEN 'completed'
    WHEN 'no_effect' THEN 'no_effect'
    ELSE 'failed'
  END;

  INSERT INTO public.jobs_jobreconciliationdecision (
    id, job_id, exit, operation_outcome,
    compute_terminated_provider, compute_terminated_resource_id,
    compute_terminated_request_id, compute_terminated_observed_at,
    target_read_provider, target_read_resource_id,
    target_read_request_id, target_read_observed_at,
    unresolved_step_id, unresolved_operation_ref, dispatch_outcome_at_decision,
    decided_by_identity_id, decided_by_role, decided_at
  ) VALUES (
    v_decision_id, p_job_id, v_exit, v_outcome,
    v_c_provider, v_c_resource, v_c_request, v_c_observed,
    v_t_provider, v_t_resource, v_t_request, v_t_observed,
    v_unresolved_step_id, v_unresolved_op_ref, v_closed_outcome,
    p_actor_identity, 'staff_operator', v_decided_at
  );

  INSERT INTO public.audit_auditevent (
    id, occurred_at, actor_type, actor_id, actor_label,
    organisation_id, action, target_urn, request_id, job_id,
    retention_class, metadata
  ) VALUES (
    v_decision_audit_id, clock_timestamp(), 'staff', p_actor_identity,
    'urn:kodera:identity:' || p_actor_identity::text,
    v_organisation_id, 'job.reconciliation_decided',
    'urn:kodera:job:' || p_job_id::text, p_request_id, p_job_id,
    'standard',
    jsonb_build_object(
      'exit', v_exit,
      'reconciliation_decision_ref', v_decision_id::text,
      'staff_role_grant_ref', v_grant_id::text
    )
  );

  IF v_dispatch_id IS NOT NULL THEN
    UPDATE public.jobs_jobdispatch
      SET closed_at = clock_timestamp(),
          terminal_outcome = v_closes_with,
          terminal_evidence_ref = v_t_request
      WHERE id = v_dispatch_id AND closed_at IS NULL;
  END IF;

  IF v_exit = 'resume' THEN
    v_step_next_status := CASE WHEN v_outcome = 'completed' THEN 'succeeded' ELSE 'pending' END;
    UPDATE public.jobs_jobstep SET status = v_step_next_status WHERE id = v_unresolved_step_id;

    IF v_outcome = 'completed' THEN
      SELECT st.seq, st.output_ref INTO v_step_seq, v_step_output_ref
        FROM public.jobs_jobstep st WHERE st.id = v_unresolved_step_id;
      INSERT INTO public.audit_auditevent (
        id, occurred_at, actor_type, actor_id, actor_label,
        organisation_id, action, target_urn, request_id, job_id,
        retention_class, metadata
      ) VALUES (
        v_step_audit_id, clock_timestamp(), 'system', NULL, 'system',
        v_organisation_id, 'job.step_succeeded',
        'urn:kodera:job:' || p_job_id::text, NULL, p_job_id,
        'standard',
        jsonb_build_object(
          'seq', v_step_seq,
          'step_id', v_unresolved_step_id::text,
          'output_ref', v_step_output_ref
        )
      );
    END IF;

    UPDATE public.jobs_job
      SET status = 'queued',
          lease_expires_at = NULL,
          reconciliation_decision_ref = v_decision_id,
          updated_at = clock_timestamp()
      WHERE id = p_job_id;
    v_new_status := 'queued';
  ELSE
    UPDATE public.jobs_job
      SET status = 'failed',
          error_code = 'reconciliation_failed',
          lease_expires_at = NULL,
          reconciliation_decision_ref = v_decision_id,
          updated_at = clock_timestamp()
      WHERE id = p_job_id;
    UPDATE public.jobs_joblockreservation
      SET ended_at = clock_timestamp()
      WHERE job_id = p_job_id AND ended_at IS NULL;
    IF v_parent_job_id IS NOT NULL THEN
      UPDATE public.jobs_jobdispatch
        SET closed_at = clock_timestamp(),
            terminal_outcome = 'failed',
            terminal_evidence_ref = operation_ref
        WHERE sub_job_id = p_job_id AND closed_at IS NULL;
    END IF;
    v_new_status := 'failed';
  END IF;

  SELECT o.slug INTO v_org_slug
    FROM public.orgs_organisation o
    WHERE o.id = v_organisation_id AND o.deleted_at IS NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'decision_id', v_decision_id::text,
    'new_status', v_new_status,
    'organisation_slug', v_org_slug
  );
END $$;
REVOKE ALL ON FUNCTION staff_reconcile_job(uuid, uuid, jsonb, text) FROM PUBLIC;

CREATE FUNCTION staff_reconcile_delivery(
  p_actor_identity uuid,
  p_delivery_id uuid,
  p_decision jsonb,
  p_request_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  v_decision_id uuid;
  v_decision_audit_id uuid;
  v_exit text;
  v_outcome text;
  v_c_provider text;
  v_c_resource text;
  v_c_request text;
  v_c_observed timestamptz;
  v_t_provider text;
  v_t_resource text;
  v_t_request text;
  v_t_observed timestamptz;
  v_status text;
  v_started_at timestamptz;
  v_organisation_id uuid;
  v_decided_at timestamptz;
  v_grant_id uuid;
  v_new_status text;
  v_org_slug text;
BEGIN
  IF p_actor_identity IS NULL OR p_delivery_id IS NULL OR p_decision IS NULL
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{8,64}$' THEN
    RAISE EXCEPTION 'staff delivery reconciliation input refused' USING ERRCODE = '23514';
  END IF;

  IF to_regclass('public.outbox_outboxdelivery') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'outbox_unavailable');
  END IF;

  v_decision_id := (p_decision->>'decision_id')::uuid;
  v_decision_audit_id := (p_decision->>'decision_audit_id')::uuid;
  v_exit := p_decision->>'exit';
  v_outcome := p_decision->>'operation_outcome';
  v_c_provider := p_decision->>'c_provider';
  v_c_resource := p_decision->>'c_resource_id';
  v_c_request := p_decision->>'c_request_id';
  v_c_observed := (p_decision->>'c_observed_at')::timestamptz;
  v_t_provider := p_decision->>'t_provider';
  v_t_resource := p_decision->>'t_resource_id';
  v_t_request := p_decision->>'t_request_id';
  v_t_observed := (p_decision->>'t_observed_at')::timestamptz;

  IF v_decision_id IS NULL OR v_decision_audit_id IS NULL
     OR v_exit NOT IN ('resume', 'fail')
     OR v_outcome NOT IN ('completed', 'no_effect', 'partial') THEN
    RAISE EXCEPTION 'staff delivery reconciliation payload refused' USING ERRCODE = '23514';
  END IF;

  SELECT d.status, d.started_at, d.organisation_id
    INTO v_status, v_started_at, v_organisation_id
    FROM public.outbox_outboxdelivery d
    WHERE d.id = p_delivery_id
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'delivery_not_found');
  END IF;

  IF v_status <> 'needs_reconciliation' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_in_reconciliation');
  END IF;

  v_decided_at := clock_timestamp();

  SELECT r.id INTO v_grant_id
    FROM public.identity_staffrole r
    JOIN public.identity_identity i ON i.id = r.identity_id
    JOIN public.identity_user u ON u.id = i.user_id
    WHERE r.identity_id = p_actor_identity
      AND r.realm = 'kodera-staff'
      AND r.role = 'staff_operator'
      AND r.revoked_at IS NULL
      AND i.deleted_at IS NULL
      AND i.enabled = TRUE
      AND u.deleted_at IS NULL
      AND u.enabled = TRUE
    ORDER BY r.created_at, r.id
    LIMIT 1
    FOR SHARE OF r, i, u;
  IF v_grant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'role_missing');
  END IF;

  IF v_started_at IS NOT NULL AND v_started_at > v_decided_at THEN
    RETURN jsonb_build_object('ok', false, 'error', 'evidence_out_of_order_start');
  END IF;
  IF v_started_at IS NOT NULL AND NOT (v_started_at - interval '5 minutes' < v_c_observed) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'evidence_out_of_order_compute');
  END IF;
  IF NOT (v_c_observed <= v_t_observed) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'evidence_out_of_order_target');
  END IF;
  IF NOT (v_t_observed <= v_decided_at + interval '5 minutes') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'evidence_out_of_order_future');
  END IF;
  IF v_outcome = 'partial' AND v_exit = 'resume' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'partial_resume');
  END IF;

  INSERT INTO public.outbox_deliverydecision (
    id, delivery_id, exit, operation_outcome,
    compute_terminated_provider, compute_terminated_resource_id,
    compute_terminated_request_id, compute_terminated_observed_at,
    target_read_provider, target_read_resource_id,
    target_read_request_id, target_read_observed_at,
    decided_by_identity_id, decided_by_role
  ) VALUES (
    v_decision_id, p_delivery_id, v_exit, v_outcome,
    v_c_provider, v_c_resource, v_c_request, v_c_observed,
    v_t_provider, v_t_resource, v_t_request, v_t_observed,
    p_actor_identity, 'staff_operator'
  );

  INSERT INTO public.audit_auditevent (
    id, occurred_at, actor_type, actor_id, actor_label,
    organisation_id, action, target_urn, request_id,
    retention_class, metadata
  ) VALUES (
    v_decision_audit_id, clock_timestamp(), 'staff', p_actor_identity,
    'urn:kodera:identity:' || p_actor_identity::text,
    v_organisation_id, 'outbox_delivery.reconciliation_decided',
    'urn:kodera:outbox_delivery:' || p_delivery_id::text, p_request_id,
    'standard',
    jsonb_build_object(
      'exit', v_exit,
      'reconciliation_decision_ref', v_decision_id::text,
      'staff_role_grant_ref', v_grant_id::text
    )
  );

  v_new_status := CASE
    WHEN v_exit = 'fail' THEN 'failed'
    WHEN v_outcome = 'completed' THEN 'succeeded'
    ELSE 'pending'
  END;

  UPDATE public.outbox_outboxdelivery
    SET status = v_new_status,
        reconciliation_decision_ref = v_decision_id,
        updated_at = clock_timestamp()
    WHERE id = p_delivery_id;

  SELECT o.slug INTO v_org_slug
    FROM public.orgs_organisation o
    WHERE o.id = v_organisation_id AND o.deleted_at IS NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'decision_id', v_decision_id::text,
    'new_status', v_new_status,
    'organisation_slug', v_org_slug
  );
END $$;
REVOKE ALL ON FUNCTION staff_reconcile_delivery(uuid, uuid, jsonb, text) FROM PUBLIC;
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP FUNCTION staff_reconcile_delivery(uuid, uuid, jsonb, text);
DROP FUNCTION staff_reconcile_job(uuid, uuid, jsonb, text);
DROP FUNCTION staff_sync_identity_bridge_role(uuid, uuid, text, text, uuid);
DROP FUNCTION staff_read_outbox_sre_summary(uuid);
DROP FUNCTION staff_fence_caller(uuid, uuid, text, text, text[]);
"""


class Migration(migrations.Migration):
    dependencies = [
        ("staff_api", "0001_initial"),
    ]

    operations = [
        migrations.RunSQL(FORWARD, reverse_sql=REVERSE),
    ]
