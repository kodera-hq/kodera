// Retire prepared requests synchronously, before asynchronous session cleanup.
let generation = 0

export function retireSessionGeneration(): void {
  generation++
}

interface SessionBridge {
  readonly sessionGeneration?: number
}

function currentBridge(): SessionBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { koderaDesktop?: SessionBridge }).koderaDesktop
}

export function captureSessionGeneration(): () => boolean {
  const prepared = generation
  const bridge = currentBridge()
  const nativeGeneration = bridge?.sessionGeneration
  return () =>
    generation === prepared &&
    currentBridge() === bridge &&
    bridge?.sessionGeneration === nativeGeneration
}
