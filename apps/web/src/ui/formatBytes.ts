export function formatBytes(bytes: number, language?: string): string {
  const french = !language?.startsWith('en')
  const units = french ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, Number.isFinite(bytes) ? bytes : 0)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${new Intl.NumberFormat(french ? 'fr' : 'en', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)}\u00a0${units[unit]}`
}
