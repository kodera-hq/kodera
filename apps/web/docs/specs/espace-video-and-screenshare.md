# Espace calls: video, screen sharing, push-to-talk and reconnecting

Status: Implemented for independent review. It has been run against fakes of LiveKit and of the call, not against a live LiveKit server or real devices.

## Spec

Espace's audio rooms carry video too. The call stays the one thin layer over `livekit-client` (`src/features/espace/audio/call.ts`). Screens read its snapshot, call its actions, and never import the SDK, as the ESLint boundary already requires. This document adds what the call does with video, how the member speaks, and what happens when the connection is lost.

### Camera

- **Off by default.** The camera is off in every call and is never carried from one room to the next. Only the member turns it on, from the dock's camera toggle (`aria-pressed` while on).
- **Turning it on.** The call asks LiveKit for a 720p capture. While the browser asks for permission, the toggle says it is busy (`aria-busy`). A second press during that time is not a second request.
- **A refusal.** The member is told why: the browser refuses the camera to the site, no camera is connected, another application holds it, or another reason. The camera stays off.
- **Turning it off.** The capture stops at once, through LiveKit and on the browser's own track, before the track is unpublished. The camera light goes out with the click.
- **Off while the browser still asks.** The camera never goes out once allowed.
- **Rooms without the right to publish.** A listen-only room offers no camera. A call that loses its right to publish stops the camera too.

### Screen sharing

- **Capture options.** The member picks what to share. The capture carries:
  - no sound;
  - the `detail` content hint, which keeps text and lines sharp and drops frames rather than detail;
  - Kodera's own tab excluded from the picker;
  - `degradationPreference: maintain-resolution`.
- **Resolution.** No resolution is requested, because Safari captures at a low one when any is.
- **Closing the picker.** This is a choice, not a problem, so nothing is said. Any other failure is reported.
- **Stopping.** The browser's own « Arrêter le partage » ends the share. The dock follows. Sharing again is the member's to ask.
- **Ending with the call.** Camera and screen captures end with the call: leaving, switching rooms, a removal, or a lost connection.

### Video stage (`src/features/espace/video/VideoStage.tsx`)

- **Lazy loading.** The stage is a lazy chunk, loaded only once a call has video.
- **What it shows.**
  - Shared screens come first, shown whole (`object-contain`).
  - Cameras follow and fill their tiles.
  - The member's own camera comes last, mirrored.
  - A camera that is turned off is not listed.
- **Spotlight.** A shared screen takes the spotlight, with the other feeds in a strip below it. The member can pin any feed there, and unpin it.
- **Speaking.** Whoever speaks has their camera ringed.
- **Drawing the video.** Each `<video>` is drawn by the call (`attachVideo`). It is muted, because the call's sound plays through its own hidden elements.
- **No `style` attributes.** Nothing on the stage uses one, so `style-src 'self'` and `style-src-attr 'none'` stay strict.
- **Docked presentation.** The stage can shrink to a floating thumbnail of the spotlit feed (« Réduire la vidéo en vignette »). It stays in a corner while the member moves between the workspace's channels: the Espace view, and so the call, stays mounted across those routes.
- **Leaving the workspace.** This still asks first and ends the call (`LeaveCallGuard`). Keeping a call alive across the rest of the console would move the call above the workspace route, which is out of scope here.
- **Browser picture-in-picture.** Where the browser offers its own window (`document.pictureInPictureEnabled`), each tile can open it.

### Speaking (`audio/callPreferences.ts`, `audio/pushToTalk.ts`)

« Réglages audio » adds two settings, remembered in this browser (`console:call-preferences`). An unreadable value falls back to the defaults.

**Prise de parole: « Micro ouvert » or « Appuyer pour parler »**

- **The key.** Push-to-talk listens to the key below Escape, by its physical place (`Backquote`): « ² » on a French keyboard.
- **At a join.** In this mode the microphone never turns on: the call starts muted.
- **Holding the key.** The microphone is on only while the key is held. It goes off at the release, at a window switch, when the tab is hidden, on `pagehide`, or when the mode is turned off.
- **When the key does nothing.** It never acts:
  - in a text field or an editable region;
  - with a modifier key;
  - while the member is deafened (unmuting would undeafen them);
  - in a listen-only room;
  - before the call is through.
- **Going back to an open microphone.** This never turns the microphone on.

**Réduction du bruit**

- **Default.** The browser's noise suppression is on by default.
- **Turning it off.** This applies to the live microphone (`applyConstraints`) and to every later capture (`noiseSuppression: false`). The other constraints are kept.

### Reconnecting (`audio/rejoin.ts`)

- **LiveKit's own resume.** While LiveKit resumes the connection, the dock says so.
- **Rejoining the room.** When the resume fails and the call ends with `connection-lost`, the same room is joined again after a jittered wait. The wait is about 1, 2, 4, 8 and then 16 seconds, never more than 30 seconds, for five tries.
- **Failed tries.** A try refused for a network or availability reason counts as a failed try, and the next one is scheduled.
- **Offline.** While the browser is offline, no try is spent: the next one waits for the `online` event.
- **The banner.** It replaces the problem message and shows the attempt number. It offers « Réessayer maintenant » and « Fermer ». After five failed tries, it offers « Réessayer », which starts the count again.
- **Never rejoined.** The call is never joined again after any of these:
  - a removal;
  - a closed room;
  - a call taken by another tab;
  - a microphone that could not be turned off;
  - a refusal;
  - a join the member started themselves.
- **When it stops waiting.** Leaving, joining another room or being connected again ends the wait.
- **Mute and deafen.** A retry carries the member's own mute and deafen, as any room switch does.

### Before the call is through

While the call connects, the dock lists who is already in the room. The list comes from the room's occupancy state, which everyone in the workspace sees, and leaves the member out. The sidebar keeps showing occupants, and who shares a screen, before anyone joins.

### Copy

The new labels live under `console.workspace.audio.*` in both source catalogues. The runtime catalogues are generated.

## Acceptance

Run:

`npx vitest run src/features/espace/audio src/features/espace/video src/features/espace/VoiceCallDock.video.test.tsx src/features/espace/AudioSettings.test.tsx src/ui/AudioDock src/features/espace/EspaceLiveView.test.tsx`

These tests cover:

- **Camera and screen.** Turning them on and off, and the capture stopping before the unpublish. Each refusal reason. A camera turned off while the browser still asks. A camera requested once despite repeated presses. Listen-only refusal. Camera and screen stopped by a room switch, by leaving and by a permission loss. The `detail` content hint and the capture options. A closed picker. The browser ending a share.
- **Other people's video.** Remote feeds by Matrix user, muted, unmuted and unsubscribed. Feeds whose participant is not a Matrix user are ignored.
- **Speaking.** Noise suppression, both at capture and live. Push-to-talk at a join and in every one of its refusal cases.
- **Reconnecting.** The backoff schedule. The reasons that are never retried. Offline waiting. Stopping when the member leaves or switches rooms.
- **Video stage.** Spotlight, pinning, the speaking ring, the docked thumbnail, picture-in-picture, no `style` attributes, and the stage loaded only when there is video.
- **Dock.** Its camera and screen toggles, and its pre-join presence.
- **Banner.** The banner text and its buttons in the Espace view.
