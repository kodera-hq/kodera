# Fake microphone tone

Status: Test fixture.

`tone.wav` is two seconds of mono, 48 kHz, signed 16-bit PCM: a 440 Hz sine at amplitude 12000. Chromium loops it through `--use-file-for-fake-audio-capture`; the real LiveKit receiver measures its bytes, energy and audio level. The file contains only WAV format and sample-data chunks, with no provenance or text metadata.

Regenerate from the repository root with Python's standard library:

```python
import math
import struct
import wave

with wave.open('apps/web/tests/espace/audio/tone.wav', 'wb') as tone:
    tone.setnchannels(1)
    tone.setsampwidth(2)
    tone.setframerate(48000)
    tone.writeframes(b''.join(
        struct.pack('<h', round(12000 * math.sin(2 * math.pi * 440 * i / 48000)))
        for i in range(96000)
    ))
```

Run the existing real-stack audio suite with `npx playwright test -c playwright.espace.config.ts tests/espace/audio/two-browsers.spec.ts` after its documented stack startup with Core's audio profile. The new test prints its measured added duration and refuses a two-minute overrun. Its muted-sender mutation calls the same receive assertion and requires the specific audible-audio diagnostic.
