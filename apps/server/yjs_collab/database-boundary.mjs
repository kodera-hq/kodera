/** Refuse privileged database identities before opening any listener. */
export async function assertDatabaseBoundary(pool) {
  const result = await pool.query(`SELECT
    NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
    AND NOT has_database_privilege(current_database(),'CREATE')
    AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema')
                    AND nspname !~ '^pg_' AND has_schema_privilege(oid,'CREATE'))
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner=r.oid
                    UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner=r.oid
                    UNION ALL SELECT 1 FROM pg_database WHERE datdba=r.oid)
    AND NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
      AND (c.relowner=r.oid OR (c.relkind IN ('r','p','v','m','f') AND (n.nspname<>'public' OR c.relname NOT IN
        ('docs_document','docs_documentlink','docs_documentsnapshot','docs_documentupdate'))
        AND (has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
             OR has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))))
    AND NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege(c.oid,'TRUNCATE,REFERENCES,TRIGGER')
           OR (has_table_privilege(c.oid,'DELETE') AND c.relname NOT IN ('docs_documentlink','docs_documentupdate'))))
    AND NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
      AND (has_column_privilege(c.oid,a.attnum,'REFERENCES')
           OR (has_column_privilege(c.oid,a.attnum,'INSERT') AND c.relname NOT IN ('docs_documentlink','docs_documentupdate'))
           OR (has_column_privilege(c.oid,a.attnum,'UPDATE') AND NOT
               ((c.relname='docs_document' AND a.attname IN ('markdown','revision','updated_at'))
                OR (c.relname='docs_documentsnapshot' AND a.attname IN ('sequence','head_sequence','state','updated_at'))))))
    AND NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
      AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
    AND has_function_privilege('docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text)','EXECUTE')
    AND has_function_privilege('docs_collab_audit(uuid,text,uuid,uuid,uuid,text)','EXECUTE')
    AND has_function_privilege('docs_redeem_collaboration_ticket(uuid,bigint)','EXECUTE')
    AS restricted FROM pg_roles r WHERE r.rolname=current_user`)
  if (result.rows[0]?.restricted !== true) throw new Error('collaboration database role refused')
}
