import { useEffect, useState } from 'react'

/** Profile raster bytes become a local blob, preserving img-src 'self' blob:. */
export function useWorkspaceLogo(value: string | undefined): string | undefined {
  const [image, setImage] = useState<{ value: string; src: string }>()
  useEffect(() => {
    if (!value || value.length > 2796236) return
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
    if (!match) return
    let src: string
    try {
      const bytes = Uint8Array.from(atob(match[2]!), (character) => character.charCodeAt(0))
      src = URL.createObjectURL(new Blob([bytes], { type: match[1]! }))
    } catch {
      return
    }
    let active = true
    queueMicrotask(() => {
      if (active) setImage({ value, src })
    })
    return () => {
      active = false
      URL.revokeObjectURL(src)
    }
  }, [value])
  return image?.value === value ? image?.src : undefined
}
