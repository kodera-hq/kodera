import { KoderaMark } from '../icons/KoderaMark'

export function KoderaStageMark({ animated }: { animated?: boolean }) {
  return (
    <div className="stage-reticle" aria-hidden="true">
      <span className="stage-corners" />
      <KoderaMark animated={animated} className="stage-mark" />
    </div>
  )
}
