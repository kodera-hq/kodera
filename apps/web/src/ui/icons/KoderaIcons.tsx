import type { SVGProps } from 'react'

const paths = {
  close: ['M5 5l14 14', 'M19 5 5 19'],
  workspace: ['M4 4h16v16H4zM4 9h16M9 9v11', 'M13 13h3v3h-3z'],
  messages: ['M4 4h16v12H10l-5 4v-4H4z', 'M8 8h8M8 12h5'],
  directs: ['M3 5h14v10H9l-4 4v-4H3z', 'M17 9h4v11l-4-3h-4'],
  calls: [
    'M5 3l4 2-1 5a14 14 0 0 0 6 6l5-1 2 4c-1 3-6 2-11-3S2 5 5 3Z',
    'M14 3a7 7 0 0 1 7 7M14 7a3 3 0 0 1 3 3',
  ],
  docs: ['M5 3h9l5 5v13H5zM14 3v5h5', 'M9 12h6M9 16h6'],
  drive: ['M3 8l9-5 9 5v11H3z', 'M3 8l9 5 9-5M12 13v6'],
  files: ['M3 6h7l2 3h9v12H3z', 'M7 3h11v6M7 13h10M7 17h6'],
  integrations: ['M3 3h6v6H3zM15 15h6v6h-6zM9 6h6v9', 'M3 15h6v6H3zM15 3h6v6h-6z'],
  shield: ['M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6z', 'M8 12l3 3 5-6'],
  passport: ['M5 3h14v18H5z', 'M9 8a3 3 0 1 0 6 0 3 3 0 0 0-6 0M8 16h8'],
  roles: [
    'M8 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6M2 20v-3a6 6 0 0 1 12 0v3',
    'M17 4l4 2v4l-4 3-4-3V6zM17 16h4M17 20h4',
  ],
  pin: ['M8 3h8l-1 6 4 4H5l4-4z', 'M12 13v9'],
  thread: ['M4 3h16v12H9l-5 4z', 'M8 7h8M8 11h5M13 19h7'],
  search: ['M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0', 'M15 15l6 6'],
  command: [
    'M8 8H5a3 3 0 1 1 3-3v14a3 3 0 1 1-3-3h14a3 3 0 1 1-3 3V5a3 3 0 1 1 3 3H8',
    'M8 8h8v8H8z',
  ],
  spark: ['M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z', 'M19 2v4M17 4h4'],
  grid: ['M3 3h7v7H3zM14 14h7v7h-7z', 'M14 3h7v7h-7zM3 14h7v7H3z'],
  list: ['M8 5h13M8 12h13M8 19h13', 'M3 5h1M3 12h1M3 19h1'],
  upload: ['M12 16V3m-5 5 5-5 5 5', 'M3 15v6h18v-6'],
  download: ['M12 3v13m-5-5 5 5 5-5', 'M3 16v5h18v-5'],
  left: ['M15 5l-7 7 7 7', 'M8 12h13'],
  right: ['M9 5l7 7-7 7', 'M3 12h13'],
  settings: ['M3 7h18M3 17h18', 'M8 4v6M16 14v6'],
} as const
export type KoderaIconName = keyof typeof paths
export const KODERA_ICON_NAMES = Object.keys(paths) as KoderaIconName[]

/** Geometry stays neutral; the surrounding token ink supplies the theme. */
export function KoderaIcon({
  name,
  className = 'h-4 w-4 shrink-0',
  ...props
}: SVGProps<SVGSVGElement> & { name: KoderaIconName }) {
  return (
    <svg
      {...props}
      data-kodera-icon={name}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={paths[name][0]} />
      <path d={paths[name][1]} opacity="0.55" />
    </svg>
  )
}
