// Core ownership for actual mock IdP recovery; no auth adapter is replaced.
import { http, HttpResponse } from 'msw/http'
import { ownedOrderMe } from '../orderIdentity'

export const handlers = [
  http.get('*/api/v1/me', async () => {
    const control = window.sessionStorage.getItem('msw:people-recovery-control')
    if (control === 'hold') {
      window.sessionStorage.setItem('msw:people-recovery-requested', '1')
      await new Promise<void>((resolve) => {
        window.addEventListener('mock-people-recovery-release', () => resolve(), { once: true })
      })
    }
    const me = ownedOrderMe()
    if (control === 'changed-core-owner') {
      const identityId = '1ce13f37-946f-43ea-bd5e-cf2c9c32f330'
      me.identities[0]!.id = identityId
      me.organisations[0]!.identity_id = identityId
      me.organisations[0]!.membership_id = '9a6b172c-8e84-48ef-8f2f-ac7f9cf1dc4b'
    }
    return HttpResponse.json(me)
  }),
]
