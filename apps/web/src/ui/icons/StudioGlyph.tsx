const paths = {
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  message: 'M5 3h14v15h-7l-5 4v-4H3V3h2',
  docs: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h6',
  calls: 'M5 3l4 1 1 5-3 2a15 15 0 0 0 6 6l2-3 5 1 1 4c-1 3-5 3-10-1C5 14 1 7 5 3Z',
  files: 'm3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 17l9 5 9-5',
  integrations: 'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6z',
  bold: 'M6 3h7a5 5 0 0 1 0 9H6V3Zm0 9h8a5 5 0 0 1 0 9H6v-9Z',
  italic: 'M10 3h10M4 21h10M15 3 9 21',
  list: 'M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01',
  task: 'M3 3h18v18H3zM7 12l3 3 7-7',
  link: 'm10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  mention: 'M16 8v7c0 4 7 3 7-4a10 10 0 1 0-5 10M16 12a4 4 0 1 1-8 0 4 4 0 0 0 8 0',
  star: 'm12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z',
  camera: 'M3 6h12v12H3zM15 10l6-3v10l-6-3M3 3l18 18',
  share:
    'M16 21v-3a5 5 0 0 0-5-5H7a5 5 0 0 0-5 5v3M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M17 3a4 4 0 0 1 0 8M22 21v-3a5 5 0 0 0-4-5',
} as const
export type StudioGlyphName = keyof typeof paths
export function StudioGlyph({ name }: { name: StudioGlyphName }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <path d={paths[name]} />
    </svg>
  )
}
