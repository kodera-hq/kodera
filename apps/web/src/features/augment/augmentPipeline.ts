export type AugmentPresetId =
  | 'vrm-robot'
  | 'vrm-fox-givre'
  | 'mask-wireframe'
  | 'privacy-blur'
  | 'camera-raw'

export type AugmentTargetFps = 30 | 60

export type BlendshapeKey =
  | 'jawOpen'
  | 'eyeBlinkLeft'
  | 'eyeBlinkRight'
  | 'mouthSmile'
  | 'browInnerUp'

export interface AugmentPresetDescriptor {
  readonly id: AugmentPresetId
  readonly name: string
  readonly kind: 'vrm-avatar' | 'ar-mask' | 'privacy-filter' | 'passthrough'
  readonly badge: string
  readonly description: string
  readonly blendshapesActive: boolean
}

export const AUGMENT_PIPELINE_SIGNATURE =
  'getUserMedia -> 52 ARKit blendshapes via MediaPipe -> VRM 1.0 3D avatar renderer at 30-60 FPS -> MediaStreamTrack'

export const AUGMENT_PRIVACY_BADGE =
  'Exécution WebGPU/WASM 100 % locale — aucune image caméra ni donnée biométrique ne quitte votre appareil'

export const AUGMENT_PRESETS: readonly AugmentPresetDescriptor[] = [
  {
    id: 'vrm-robot',
    name: 'Robot Kodera (VRM 1.0)',
    kind: 'vrm-avatar',
    badge: 'VRM 1.0 · 6-DoF',
    description:
      'Avatar robotique 3D articulé par 52 blendshapes ARKit et suivi crânien temps réel.',
    blendshapesActive: true,
  },
  {
    id: 'vrm-fox-givre',
    name: 'Renard Givre (VRM 1.0)',
    kind: 'vrm-avatar',
    badge: 'VRM 1.0 · Studio',
    description:
      'Avatar expressif Kodera Community avec synchronisation labiale et clignements naturels.',
    blendshapesActive: true,
  },
  {
    id: 'mask-wireframe',
    name: 'Masque Filigrane 52-Blendshapes',
    kind: 'ar-mask',
    badge: 'Maillage AR',
    description:
      'Maillage géométrique AR superposé aux 468 points MediaPipe sans révéler le visage.',
    blendshapesActive: true,
  },
  {
    id: 'privacy-blur',
    name: 'Flou Souverain Local',
    kind: 'privacy-filter',
    badge: 'WebGPU Local',
    description:
      'Segmentation et flou gaussien exécutés localement avant l’encodage WebRTC LiveKit.',
    blendshapesActive: false,
  },
  {
    id: 'camera-raw',
    name: 'Caméra Brute (Désactivé)',
    kind: 'passthrough',
    badge: 'Direct',
    description: 'Flux caméra direct sans avatar VRM ni traitement de masque AR.',
    blendshapesActive: false,
  },
] as const

export const BLENDSHAPE_KEYS: readonly BlendshapeKey[] = [
  'jawOpen',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'mouthSmile',
  'browInnerUp',
] as const

export interface AugmentPipelineState {
  readonly presetId: AugmentPresetId
  readonly smoothingPercent: number
  readonly targetFps: AugmentTargetFps
  readonly expressionMode: 'neutral' | 'smile_speech'
  readonly blendshapes: Readonly<Record<BlendshapeKey, number>>
  readonly biometricBytesSent: 0
  readonly packageName: '@augmentkit/core'
  readonly pipelineSignature: string
}

const NEUTRAL_BLENDSHAPES: Readonly<Record<BlendshapeKey, number>> = {
  jawOpen: 14,
  eyeBlinkLeft: 8,
  eyeBlinkRight: 8,
  mouthSmile: 22,
  browInnerUp: 16,
}

const SMILE_SPEECH_BLENDSHAPES: Readonly<Record<BlendshapeKey, number>> = {
  jawOpen: 68,
  eyeBlinkLeft: 18,
  eyeBlinkRight: 18,
  mouthSmile: 88,
  browInnerUp: 54,
}

function clampSmoothing(value: number): number {
  if (Number.isNaN(value)) return 50
  return Math.max(0, Math.min(100, Math.round(value)))
}

function computeSmoothedBlendshapes(
  mode: 'neutral' | 'smile_speech',
  smoothingPercent: number,
  presetId: AugmentPresetId
): Readonly<Record<BlendshapeKey, number>> {
  if (presetId === 'camera-raw') {
    return {
      jawOpen: 0,
      eyeBlinkLeft: 0,
      eyeBlinkRight: 0,
      mouthSmile: 0,
      browInnerUp: 0,
    }
  }

  const base = mode === 'smile_speech' ? SMILE_SPEECH_BLENDSHAPES : NEUTRAL_BLENDSHAPES
  const damping = (clampSmoothing(smoothingPercent) - 50) * 0.12

  return {
    jawOpen: Math.max(0, Math.min(100, Math.round(base.jawOpen - damping))),
    eyeBlinkLeft: Math.max(0, Math.min(100, Math.round(base.eyeBlinkLeft))),
    eyeBlinkRight: Math.max(0, Math.min(100, Math.round(base.eyeBlinkRight))),
    mouthSmile: Math.max(0, Math.min(100, Math.round(base.mouthSmile - damping))),
    browInnerUp: Math.max(0, Math.min(100, Math.round(base.browInnerUp - damping * 0.5))),
  }
}

export function createInitialAugmentState(
  initialPreset: AugmentPresetId = 'vrm-robot'
): AugmentPipelineState {
  const smoothingPercent = 50
  const expressionMode = 'neutral'
  return {
    presetId: initialPreset,
    smoothingPercent,
    targetFps: 60,
    expressionMode,
    blendshapes: computeSmoothedBlendshapes(expressionMode, smoothingPercent, initialPreset),
    biometricBytesSent: 0,
    packageName: '@augmentkit/core',
    pipelineSignature: AUGMENT_PIPELINE_SIGNATURE,
  }
}

export function selectAugmentPreset(
  state: AugmentPipelineState,
  presetId: AugmentPresetId
): AugmentPipelineState {
  return {
    ...state,
    presetId,
    blendshapes: computeSmoothedBlendshapes(
      state.expressionMode,
      state.smoothingPercent,
      presetId
    ),
  }
}

export function setAugmentSmoothing(
  state: AugmentPipelineState,
  smoothingPercent: number
): AugmentPipelineState {
  const clamped = clampSmoothing(smoothingPercent)
  return {
    ...state,
    smoothingPercent: clamped,
    blendshapes: computeSmoothedBlendshapes(state.expressionMode, clamped, state.presetId),
  }
}

export function setAugmentTargetFps(
  state: AugmentPipelineState,
  targetFps: AugmentTargetFps
): AugmentPipelineState {
  return {
    ...state,
    targetFps: targetFps === 30 ? 30 : 60,
  }
}

export function triggerAugmentExpressionTest(
  state: AugmentPipelineState
): AugmentPipelineState {
  const nextMode: 'neutral' | 'smile_speech' =
    state.expressionMode === 'neutral' ? 'smile_speech' : 'neutral'
  return {
    ...state,
    expressionMode: nextMode,
    blendshapes: computeSmoothedBlendshapes(nextMode, state.smoothingPercent, state.presetId),
  }
}
