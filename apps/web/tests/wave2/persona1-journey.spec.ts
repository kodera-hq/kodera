import { test } from '@playwright/test'
import { throughKeycloak } from './keycloak'
import { linkFromMail, mailLinkPattern } from './mailpit'
import { exactOrigin, guard } from './oracles/shared'
import { readWave2Input, targets, withActors } from './world'

test('Persona 1: owned claim and separate invited-member acceptance', async ({ browser }) => {
  const input = readWave2Input('PERSONA1')
  exactOrigin(input.mailpitOrigin)
  await withActors(browser, input, ['A', 'B'], async (actors) => {
    for (const alias of ['A', 'B'] as const) {
      const actor = actors[alias]!
      const isOwner = alias === 'A'
      const prefix = isOwner ? 'claim' : 'invitations/accept'
      const path = `/${prefix}/${encodeURIComponent(actor.input.organisationId)}/${encodeURIComponent(actor.input.organisation)}`
      // The mail supplies the one-use fragment; never attach the URL or message to the receipt.
      const link = await linkFromMail(
        actor.context.request,
        input.mailpitOrigin,
        actor.input.account.email,
        mailLinkPattern(`${targets().web}${path}`)
      )
      guard(
        new URL(link).origin === targets().web && new URL(link).pathname === path,
        'WAVE2_MAIL_TARGET'
      )
      await actor.page.goto(link)
      const popupOpened = actor.page.waitForEvent('popup')
      await actor.page.getByRole('button', { name: 'Se connecter', exact: true }).click()
      await throughKeycloak(await popupOpened, actor.input.account)
      const endpoint = isOwner
        ? '/api/v1/owner-claims/actions/consume'
        : '/api/v1/invitations/accept'
      const consumed = actor.page.waitForResponse(
        (response) =>
          response.url() === `${targets().api}${endpoint}` && response.request().method() === 'POST'
      )
      let answered = false
      void consumed.then(() => {
        answered = true
      })
      const membership = actor.page.waitForResponse(
        (response) =>
          answered &&
          response.url() === `${targets().api}/api/v1/me` &&
          response.request().method() === 'GET'
      )
      await actor.page
        .getByRole('button', { name: isOwner ? 'Devenir propriétaire' : /^Rejoindre / })
        .click()
      guard((await consumed).status() === 200, 'WAVE2_ONE_USE_STATUS')
      const me = await membership
      guard(me.status() === 200, 'WAVE2_ME_STATUS')
      actor.assertMembership(await me.json())
      guard(new URL(actor.page.url()).hash === '', 'WAVE2_FRAGMENT_RETIRED')
      await actor.workspace(input.workspaceReady)
      actor.budget.rememberState(alias, await actor.context.storageState())
      actor.budget.assertExact(alias, { 'core-token': 2, 'matrix-login': 1, 'local-join': 2 })
    }
  })
})
