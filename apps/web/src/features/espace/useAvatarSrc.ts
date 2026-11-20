// A member's avatar as an `<img src>`: the `blob:` address the store's cache holds for their
// `mxc://` one, once it has arrived, and nothing before (the initials stand in meanwhile). Reading
// it asks for it; the image arriving draws the faces again, nothing else.

import { useCallback, useSyncExternalStore } from 'react'
import type { AvatarCache } from './matrix/avatarCache'

const noSubscription = () => () => {}
const NO_VERSION = () => 0

export function useAvatarSrc(
  cache: AvatarCache | undefined,
  mxcUrl: string | undefined
): string | undefined {
  useSyncExternalStore(cache?.subscribe ?? noSubscription, cache?.getVersion ?? NO_VERSION)
  return mxcUrl === undefined ? undefined : cache?.get(mxcUrl)
}

/** What a broken avatar image does: the cache drops it, and the initials stand in. */
export function useForgetAvatar(cache: AvatarCache | undefined, mxcUrl: string | undefined) {
  return useCallback(() => {
    if (mxcUrl !== undefined) cache?.forget(mxcUrl)
  }, [cache, mxcUrl])
}
