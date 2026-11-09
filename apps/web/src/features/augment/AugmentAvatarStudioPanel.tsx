import { useId, useState, type ChangeEvent } from 'react'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import { cx } from '../../ui/cx'
import {
  AUGMENT_PIPELINE_SIGNATURE,
  AUGMENT_PRESETS,
  AUGMENT_PRIVACY_BADGE,
  BLENDSHAPE_KEYS,
  createInitialAugmentState,
  selectAugmentPreset,
  setAugmentSmoothing,
  setAugmentTargetFps,
  triggerAugmentExpressionTest,
  type AugmentPresetId,
  type AugmentTargetFps,
} from './augmentPipeline'

export interface AugmentAvatarStudioPanelProps {
  readonly defaultPresetId?: AugmentPresetId | undefined
  readonly onPresetChange?: ((presetId: AugmentPresetId) => void) | undefined
  readonly onClose?: (() => void) | undefined
}

export function AugmentAvatarStudioPanel({
  defaultPresetId = 'vrm-robot',
  onPresetChange,
  onClose,
}: AugmentAvatarStudioPanelProps) {
  const headingId = useId()
  const smoothingInputId = useId()
  const [state, setState] = useState(() => createInitialAugmentState(defaultPresetId))

  const activePreset =
    AUGMENT_PRESETS.find((preset) => preset.id === state.presetId) ?? AUGMENT_PRESETS[0]!

  const handleSelectPreset = (presetId: AugmentPresetId) => {
    setState((prev) => selectAugmentPreset(prev, presetId))
    onPresetChange?.(presetId)
  }

  const handleSmoothingChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = Number(event.target.value)
    setState((prev) => setAugmentSmoothing(prev, nextValue))
  }

  const handleFpsChange = (fps: AugmentTargetFps) => {
    setState((prev) => setAugmentTargetFps(prev, fps))
  }

  const handleExpressionTest = () => {
    setState((prev) => triggerAugmentExpressionTest(prev))
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="kodera-augment-studio-panel"
      className="flex flex-col gap-4"
    >
      <Card>
        <CardBody className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill state="success">Open-AugmentKit · WebGPU Local</StatusPill>
                <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs font-medium text-c-ink">
                  {state.packageName}
                </span>
                <span className="rounded-sm bg-c-ok-soft px-2 py-1 font-mono text-xs font-medium text-c-ok-ink">
                  0 B biométrique transmis
                </span>
              </div>
              <h2 id={headingId} className="text-lg font-semibold text-c-ink">
                Studio Avatars VRM 1.0 &amp; Masques AR Visio
              </h2>
              <p className="font-mono text-xs font-regular text-c-ink-2">
                {AUGMENT_PIPELINE_SIGNATURE}
              </p>
            </div>

            {onClose ? (
              <Button
                size="sm"
                variant="secondary"
                data-testid="augment-close-btn"
                onClick={onClose}
              >
                Fermer le studio
              </Button>
            ) : null}
          </div>

          <div
            role="note"
            data-testid="augment-privacy-badge"
            className="flex items-center justify-between gap-2 rounded-md border border-c-ok-border bg-c-ok-soft px-3 py-2 text-xs font-medium text-c-ok-ink"
          >
            <span>{AUGMENT_PRIVACY_BADGE}</span>
            <span className="font-mono font-medium">0 B</span>
          </div>

          <div
            role="group"
            aria-label="Sélection du masque ou de l’avatar VRM 1.0"
            className="grid grid-cols-1 gap-2 md:grid-cols-3"
          >
            {AUGMENT_PRESETS.map((preset) => {
              const isSelected = preset.id === state.presetId
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`augment-preset-${preset.id}`}
                  aria-pressed={isSelected}
                  onClick={() => handleSelectPreset(preset.id)}
                  className={cx(
                    'flex flex-col items-start gap-2 rounded-md border p-3 text-left transition-colors focus-visible:outline-hidden focus-visible:ring',
                    isSelected
                      ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                      : 'border-c-border-soft bg-c-surface text-c-ink hover:bg-c-muted'
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{preset.name}</span>
                    <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs font-medium text-c-ink-2">
                      {preset.badge}
                    </span>
                  </div>
                  <p className="text-xs font-regular text-c-ink-2">{preset.description}</p>
                </button>
              )
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 rounded-md border border-c-border bg-c-sunken p-4 md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-c-ink">
                  Aperçu actif : {activePreset.name}
                </span>
                <StatusPill state="info">{state.targetFps} FPS</StatusPill>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={smoothingInputId} className="text-xs font-medium text-c-ink">
                    Lissage temporel des expressions (Kalman / 1-Euro)
                  </label>
                  <span
                    data-testid="augment-smoothing-value"
                    className="font-mono text-xs font-medium text-c-ink-2"
                  >
                    {state.smoothingPercent} %
                  </span>
                </div>
                <input
                  id={smoothingInputId}
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={state.smoothingPercent}
                  onChange={handleSmoothingChange}
                  data-testid="augment-smoothing-slider"
                  aria-label="Lissage temporel des expressions"
                  className="h-2 w-full cursor-pointer rounded-full bg-c-muted focus-visible:outline-hidden focus-visible:ring"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-c-ink">
                  Cadence cible MediaStreamTrack :
                </span>
                <div role="group" aria-label="Cadence cible FPS" className="flex items-center gap-2">
                  {([30, 60] as const).map((fps) => {
                    const isCurrentFps = state.targetFps === fps
                    return (
                      <button
                        key={fps}
                        type="button"
                        data-testid={`augment-fps-${fps}`}
                        aria-pressed={isCurrentFps}
                        onClick={() => handleFpsChange(fps)}
                        className={cx(
                          'rounded-md border px-3 py-1 font-mono text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring',
                          isCurrentFps
                            ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                            : 'border-c-border-soft bg-c-surface text-c-ink-2 hover:bg-c-muted'
                        )}
                      >
                        {fps} FPS
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  size="sm"
                  variant="primary"
                  data-testid="augment-expression-test-btn"
                  onClick={handleExpressionTest}
                >
                  Expression test (Sourire / Parole)
                </Button>
                <span
                  data-testid="augment-expression-mode"
                  className="font-mono text-xs font-medium text-c-ink-2"
                >
                  {state.expressionMode === 'smile_speech'
                    ? 'Mode : Sourire & Parole actifs'
                    : 'Mode : Posture neutre'}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-c-ink">
                  Télémétrie locale 52-Blendshapes ARKit (MediaPipe FaceLandmarker)
                </span>
                <span className="font-mono text-xs font-regular text-c-ink-3">5 clés phares</span>
              </div>

              <div className="flex flex-col gap-2">
                {BLENDSHAPE_KEYS.map((key) => {
                  const val = state.blendshapes[key]
                  return (
                    <div
                      key={key}
                      data-testid={`augment-blendshape-${key}`}
                      data-blendshape-value={val}
                      className="flex flex-col gap-1 rounded-sm border border-c-border-soft bg-c-surface px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-medium text-c-ink">{key}</span>
                        <span className="font-mono text-xs font-regular text-c-ink-2">
                          {val} %
                        </span>
                      </div>
                      <div
                        aria-hidden="true"
                        className="h-2 w-full overflow-hidden rounded-full bg-c-muted"
                      >
                        <div
                          className="h-full rounded-full bg-c-action transition-all"
                          style={{
                            width: `${val}%`,
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </CardBody>
      </Card>
    </section>
  )
}
