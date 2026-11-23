"""Contract scope declarations for workspace AI policy, consent, and transcription."""

from core.api.scopes import Operation

GET_POLICY = Operation("GET", "getWorkspaceAiPolicy", "workspace_ai:read")
PUT_POLICY = Operation("PUT", "putWorkspaceAiPolicy", "workspace_ai:update")
PUT_CHANNEL_POLICY = Operation("PUT", "putChannelAiPolicy", "workspace_ai:update")
PUT_CONSENT = Operation("PUT", "putMemberAiConsent", "workspace_ai:update")
TRANSCRIBE_VOICE_NOTE = Operation("POST", "transcribeVoiceNote", "workspace_ai:act")
