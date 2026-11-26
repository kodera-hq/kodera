import test from 'node:test'
import assert from 'node:assert/strict'
import { assertDatabaseBoundary } from '../database-boundary.mjs'

test('startup requires EXECUTE on the exact device-bound runtime fence', async () => {
  const required = "has_function_privilege('docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text,boolean,bigint,uuid)','EXECUTE')"
  for (const executable of [true, false]) {
    let queries = 0
    const pool = {async query(sql) {
      queries += 1
      assert.ok(sql.includes(required), 'startup must verify the ten-argument runtime fence')
      return {rows: [{restricted: executable}]}
    }}
    if (executable) await assertDatabaseBoundary(pool)
    else await assert.rejects(assertDatabaseBoundary(pool), /collaboration database role refused/)
    assert.equal(queries, 1)
  }
})
