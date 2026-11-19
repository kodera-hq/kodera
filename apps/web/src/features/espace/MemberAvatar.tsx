// A member's avatar drawn from their `mxc://` address, through the live view's cache
// (`passportContext.ts`): their picture once it has arrived, their initials until then, and for
// good where there is none or it fails to load.

import { forwardRef } from 'react'
import { Avatar, type AvatarProps } from '../../ui/Avatar/Avatar'
import { usePassportServices } from '../profile/passportContext'
import { useAvatarSrc } from './useAvatarSrc'

export const MemberAvatar = forwardRef<
  HTMLImageElement | HTMLSpanElement,
  Omit<AvatarProps, 'src'> & { mxc?: string | undefined }
>(function MemberAvatar({ mxc, ...props }, ref) {
  const src = useAvatarSrc(usePassportServices()?.avatars, mxc)
  return <Avatar ref={ref} {...props} {...(src === undefined ? {} : { src })} />
})
