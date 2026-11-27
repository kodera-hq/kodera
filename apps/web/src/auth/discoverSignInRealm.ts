import { ApiProblem } from '../api/client'
import { mutate } from '../api/mutations'
import { isOrganisationSlug } from '../api/organisationSlug'
import { forgetSharedRealmSlug, rememberSharedRealmSlug } from './sharedRealmHints'

export type SignInRealmResolution =
  | { readonly kind: 'resolved'; readonly realm: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'login-fallback' }

/** Hints may only be committed while the navigation and session still own this request. */
export async function discoverSignInRealm(
  slug: string,
  canCommit: () => boolean = () => true
): Promise<SignInRealmResolution> {
  const forget = () => {
    if (canCommit()) forgetSharedRealmSlug(slug)
  }
  if (!isOrganisationSlug(slug)) {
    forget()
    return { kind: 'not-found' }
  }
  let result: unknown
  try {
    result = await mutate({ method: 'post', path: '/auth/discover' }, { body: { slug } })
  } catch (error) {
    if (error instanceof ApiProblem) {
      if (error.status === 422 || error.status === 429) return { kind: 'login-fallback' }
      if (error.status === 401)
        throw new Error('Realm discovery failed with unexpected 401.', { cause: error })
    }
    throw error
  }
  if (result !== null && typeof result === 'object' && 'realm' in result) {
    const { realm } = result
    if (
      (realm === 'community' || realm === slug) &&
      'organisation' in result &&
      result.organisation !== null &&
      typeof result.organisation === 'object' &&
      'slug' in result.organisation &&
      result.organisation.slug === slug &&
      'realm' in result.organisation &&
      result.organisation.realm === realm
    ) {
      if (canCommit()) {
        if (realm === 'community') rememberSharedRealmSlug(slug)
        else forgetSharedRealmSlug(slug)
      }
      return { kind: 'resolved', realm }
    }
  }
  forget()
  return { kind: 'not-found' }
}
