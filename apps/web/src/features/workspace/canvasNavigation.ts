import { track } from '../../analytics/track'
import type { CanvasMode } from '../espace/liveViewModel'

interface Transition {
  readonly ready: Promise<unknown>
  readonly finished: Promise<unknown>
  skipTransition(): void
}
interface Options {
  readonly start?: ((update: () => void) => Transition) | undefined
  readonly reducedMotion: () => boolean
}

/** Latest intent wins even when a browser delays a transition's update callback. */
export class CanvasNavigation {
  private desired: CanvasMode = 'chat'
  private generation = 0
  private transition: Transition | null = null

  constructor(
    private readonly apply: (mode: CanvasMode) => void,
    private readonly options: Options
  ) {}

  change(mode: CanvasMode): void {
    if (mode === this.desired) return
    this.desired = mode
    const generation = ++this.generation
    const start = performance.now()
    this.transition?.skipTransition()
    const update = () => {
      if (generation === this.generation) {
        this.apply(mode)
        track('workspace_surface_changed', {
          surface: mode,
          duration_ms: performance.now() - start,
        })
      }
    }
    if (this.options.start === undefined || this.options.reducedMotion()) {
      update()
      return
    }
    const transition = this.options.start(update)
    this.transition = transition
    void transition.ready.catch(() => undefined)
    void transition.finished.catch(() => undefined)
  }

  dispose(): void {
    this.generation += 1
    this.transition?.skipTransition()
  }
}
