// A member's avatar drawn from their `mxc://` address, through the live view's cache
// (`passportContext.ts`): their picture once it has arrived, their initials until then, and for
// good where there is none or it fails to load.

import { forwardRef } from 'react'
import { Avatar, type AvatarProps } from '../../ui/Avatar/Avatar'
import { usePassportServices } from '../profile/passportContext'
import { useAvatarSrc, useForgetAvatar } from './useAvatarSrc'

export const MemberAvatar = forwardRef<
  HTMLImageElement | HTMLSpanElement,
  Omit<AvatarProps, 'src'> & { mxc?: string | undefined }
>(function MemberAvatar({ mxc, onError, ...props }, ref) {
  const avatars = usePassportServices()?.avatars
  const src = useAvatarSrc(avatars, mxc)
  const forget = useForgetAvatar(avatars, mxc)
  return (
    <Avatar
      ref={ref}
      {...props}
      onError={(event) => {
        forget()
        onError?.(event)
      }}
      {...(src === undefined ? {} : { src })}
    />
  )
})
