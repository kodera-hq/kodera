package io.kodera.android.session

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.IntOffset
import io.kodera.android.R
import io.kodera.android.client.AttachmentUploadPayload
import io.kodera.android.client.ChannelConversationTransport
import io.kodera.android.client.MatrixDeliveryStatus
import io.kodera.android.client.MatrixRawTimelineEvent
import io.kodera.android.client.MatrixReactionSummary
import io.kodera.android.client.MatrixRoomClient
import io.kodera.android.client.MatrixTimelineMessage
import io.kodera.android.client.MatrixTimelineReducer
import io.kodera.android.client.SessionFence
import io.kodera.android.client.WorkspaceChannel
import io.kodera.android.client.WorkspaceChannelLifecycle
import io.kodera.android.domain.AttachmentMetadataRef
import io.kodera.android.domain.AttachmentMimeType
import io.kodera.android.domain.ChannelKind
import io.kodera.android.domain.ChannelRoomState
import io.kodera.android.domain.ReactionKeyValidator
import io.kodera.android.domain.TrustPolicy
import io.kodera.android.domain.UuidV7Identifier
import io.kodera.android.ui.theme.CielBadgePill
import io.kodera.android.ui.theme.LocalKoderaPalette
import io.kodera.android.ui.theme.NativeTypography
import io.kodera.tokens.KoderaTokens
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executor
import kotlin.math.roundToInt

data class ChannelConversationScope(
    val organisationId: String,
    val channelId: String,
    val channelName: String,
    val channelTopic: String,
    val kind: ChannelKind,
    val roomState: ChannelRoomState,
    val isConfidential: Boolean? = null,
) {
    val key: String get() = "$organisationId:$channelId"

    companion object {
        fun fromChannel(organisationId: String, channel: WorkspaceChannel): ChannelConversationScope? {
            if (!TrustPolicy.canonicalNonNilUUID(organisationId) ||
                !TrustPolicy.canonicalNonNilUUID(channel.id) ||
                channel.lifecycle != WorkspaceChannelLifecycle.ACTIVE
            ) {
                return null
            }
            return ChannelConversationScope(
                organisationId = organisationId,
                channelId = channel.id,
                channelName = channel.name,
                channelTopic = channel.topic,
                kind = channel.kind,
                roomState = channel.roomState,
                isConfidential = channel.isConfidential,
            )
        }
    }
}

/**
 * Session-fenced conversation controller managing a channel's live Matrix timeline,
 * optimistic `UUIDv7` sends with retry, `m.in_reply_to` replies, single-grapheme reactions,
 * and Core-scoped attachments.
 */
class ChannelConversationController(
    val scope: ChannelConversationScope,
    private val transport: ChannelConversationTransport? = null,
    ownUserId: String = "@me:kodera.local",
    private val mainExecutor: Executor = Executor { it.run() },
    private val workerExecutor: Executor = Executor { it.run() },
    val fence: SessionFence = SessionFence(),
    initialForeground: Boolean = true,
) {
    private data class FailedOutbound(
        val body: String,
        val replyToEventId: String?,
        val stagedPayloads: List<AttachmentUploadPayload>,
        val uploadedRefs: List<AttachmentMetadataRef>,
    )

    private val lock = Any()
    private val reducer = MatrixTimelineReducer(transport?.ownUserId ?: ownUserId)
    private var roomId: String? = null
    private var sinceToken: String? = null
    private var requiresFullSync = false
    private val failedOutbounds = HashMap<String, FailedOutbound>()
    private var localReactionCounter = 0
    private val _isForeground = MutableStateFlow(initialForeground)
    val isForeground: StateFlow<Boolean> = _isForeground.asStateFlow()
    private var syncCycleFence: SessionFence = newChildSyncFence()
    @Volatile private var cleared = false
    private var bootstrapInFlight = false
    private var bootstrapAttempted = false
    private var backgroundedDuringBootstrap = false
    private var syncInFlight = false

    val isCleared: Boolean
        get() = cleared || fence.isInvalidated

    val isBootstrapped: Boolean
        get() = synchronized(lock) { roomId != null }

    val hasAttemptedBootstrap: Boolean
        get() = synchronized(lock) { bootstrapAttempted }

    val hasLiveTransport: Boolean
        get() = transport != null

    private fun newChildSyncFence(): SessionFence =
        SessionFence().also { child -> fence.registerCancellation { child.invalidate() } }

    /**
     * Updates foreground activity:
     * - On `false`, immediately invalidates `syncCycleFence` to cancel in-flight periodic `/sync`
     *   calls without aborting an in-flight SSO/room `bootstrap()` (which is bound to `fence`).
     * - On `true`, if already bootstrapped, triggers an immediate catch-up `refreshSync()` under
     *   the fresh `syncCycleFence`.
     */
    fun onForegroundChanged(foreground: Boolean) {
        _isForeground.value = foreground
        if (!foreground) {
            val (cancelledFence, bootstrapRunning) = synchronized(lock) {
                val previous = syncCycleFence
                syncCycleFence = newChildSyncFence()
                syncInFlight = false
                if (bootstrapInFlight) {
                    backgroundedDuringBootstrap = true
                }
                previous to bootstrapInFlight
            }
            cancelledFence.invalidate()
            if (!bootstrapRunning) {
                isSyncing = false
            }
        } else {
            val shouldCatchUp = synchronized(lock) {
                roomId != null && !bootstrapInFlight && !syncInFlight
            }
            if (shouldCatchUp && !isCleared && transport != null) {
                refreshSync()
            }
        }
    }

    var messages by mutableStateOf<List<MatrixTimelineMessage>>(emptyList())
        private set
    var composerText by mutableStateOf("")
        private set
    var activeReplyTarget by mutableStateOf<MatrixTimelineMessage?>(null)
        private set
    var stagedAttachments by mutableStateOf<List<AttachmentUploadPayload>>(emptyList())
        private set
    var expandedReactionMessageKey by mutableStateOf<String?>(null)
        private set
    @get:StringRes
    var syncStatusRes by mutableStateOf(R.string.conversation_status_connecting)
        private set
    var isSyncing by mutableStateOf(false)
        private set

    var isConfidential by mutableStateOf(scope.isConfidential)
        private set

    var plaintextAllowed by mutableStateOf(false)
        private set

    val canSend: Boolean
        get() = !isCleared && _isForeground.value && isConfidential == false && (transport == null || plaintextAllowed) &&
            (composerText.trim().isNotEmpty() || stagedAttachments.isNotEmpty())

    fun updateChannelSecurity(confidential: Boolean?) {
        if (isConfidential == confidential) return
        isConfidential = confidential
        plaintextAllowed = false
        syncStatusRes = R.string.conversation_status_secure_transport_required
        transport?.updateChannelSecurity(scope.organisationId, scope.channelId, confidential)
    }

    fun updateComposerText(value: String) {
        if (!isCleared) composerText = value
    }

    fun selectReplyTarget(message: MatrixTimelineMessage) {
        if (!isCleared && !message.isRedacted) {
            activeReplyTarget = message
        }
    }

    fun clearReplyTarget() {
        activeReplyTarget = null
    }

    fun toggleReactionBar(messageKey: String) {
        if (!isCleared) {
            expandedReactionMessageKey = if (expandedReactionMessageKey == messageKey) null else messageKey
        }
    }

    fun stageAttachment(payload: AttachmentUploadPayload) {
        if (isConfidential != false || (transport != null && !plaintextAllowed)) return
        if (!isCleared && stagedAttachments.size < AttachmentMetadataRef.MAX_REFS_PER_MESSAGE) {
            stagedAttachments = stagedAttachments + payload
        }
    }

    /** Reads picked document metadata and bytes off the UI thread, fenced by session/controller lifetime. */
    fun stageAttachmentFromUri(context: Context, uri: Uri) {
        val appContext = context.applicationContext ?: context
        stageAttachmentFromReader {
            readPickedDocument(appContext, uri) { isCleared }
        }
    }

    internal fun stageAttachmentFromReader(reader: () -> AttachmentUploadPayload?) {
        if (isCleared) return
        workerExecutor.execute {
            if (isCleared) return@execute
            val payload = runCatching { reader() }.getOrNull() ?: return@execute
            mainExecutor.execute {
                if (!isCleared) {
                    stageAttachment(payload)
                }
            }
        }
    }

    fun removeStagedAttachment(index: Int) {
        if (!isCleared && index in stagedAttachments.indices) {
            stagedAttachments = stagedAttachments.filterIndexed { i, _ -> i != index }
        }
    }

    fun bootstrap() {
        if (isCleared || !_isForeground.value) return
        val activeTransport = transport
        if (activeTransport == null) {
            syncStatusRes = R.string.conversation_status_offline
            return
        }
        synchronized(lock) {
            if (roomId != null || bootstrapInFlight) return
            bootstrapInFlight = true
            bootstrapAttempted = true
            backgroundedDuringBootstrap = false
        }
        isSyncing = true
        syncStatusRes = R.string.conversation_status_connecting
        workerExecutor.execute {
            if (isCleared) {
                synchronized(lock) { bootstrapInFlight = false }
                return@execute
            }
            val result = runCatching {
                activeTransport.bootstrapRoom(scope.organisationId, scope.channelId, null)
            }
            mainExecutor.execute {
                val (wasCleared, shouldCatchUpAfterSso) = synchronized(lock) {
                    bootstrapInFlight = false
                    val bg = backgroundedDuringBootstrap
                    backgroundedDuringBootstrap = false
                    isCleared to (bg && _isForeground.value)
                }
                if (wasCleared) return@execute
                isSyncing = false
                result.onSuccess { boot ->
                    val snapshot = synchronized(lock) {
                        reducer.updateOwnUserId(activeTransport.ownUserId)
                        roomId = boot.roomId
                        sinceToken = boot.initialBatch.nextBatch
                        val delta = boot.initialBatch.roomDeltas[boot.roomId]
                        if (delta != null) {
                            reducer.applySyncDelta(delta)
                        } else {
                            boot.initialBatch.roomEvents[boot.roomId]?.let(reducer::applyEvents)
                        }
                        reducer.messages()
                    }
                    messages = snapshot
                    plaintextAllowed = isConfidential == false && boot.initialBatch.plaintextAllowedRooms.contains(boot.roomId)
                    syncStatusRes = if (plaintextAllowed) R.string.conversation_status_live else R.string.conversation_status_secure_transport_required
                    if (shouldCatchUpAfterSso) {
                        refreshSync()
                    }
                }.onFailure {
                    syncStatusRes = R.string.conversation_status_offline
                }
            }
        }
    }

    fun refreshSync() {
        if (isCleared || !_isForeground.value) return
        val activeTransport = transport
        if (activeTransport == null) {
            syncStatusRes = R.string.conversation_status_offline
            return
        }
        val (currentRoom, currentSince, cycleFence) = synchronized(lock) {
            if (bootstrapInFlight) return
            if (roomId == null) Triple(null, null, syncCycleFence)
            else if (syncInFlight) return
            else {
                syncInFlight = true
                Triple(roomId, if (requiresFullSync) null else sinceToken, syncCycleFence)
            }
        }
        if (currentRoom == null) {
            bootstrap()
            return
        }
        isSyncing = true
        workerExecutor.execute {
            if (isCleared || cycleFence.isInvalidated || !_isForeground.value) {
                synchronized(lock) {
                    if (syncCycleFence === cycleFence) syncInFlight = false
                }
                return@execute
            }
            val result = runCatching {
                val batch = activeTransport.syncRoom(currentRoom, currentSince, cycleFence)
                val delta = batch.roomDeltas[currentRoom]
                val prevBatch = delta?.prevBatch
                val backfilled: List<MatrixRawTimelineEvent> =
                    if (delta != null && delta.limited && !prevBatch.isNullOrEmpty() && !isCleared && !cycleFence.isInvalidated) {
                        runCatching {
                            activeTransport.backfillRoomMessages(
                                currentRoom,
                                prevBatch,
                                MatrixRoomClient.SYNC_TIMELINE_LIMIT,
                                cycleFence,
                            )
                        }.getOrDefault(emptyList())
                    } else {
                        emptyList()
                    }
                batch to backfilled
            }
            mainExecutor.execute {
                val stillCurrentCycle = synchronized(lock) {
                    if (syncCycleFence === cycleFence) {
                        syncInFlight = false
                        true
                    } else {
                        false
                    }
                }
                if (isCleared || !stillCurrentCycle || cycleFence.isInvalidated || !_isForeground.value) return@execute
                isSyncing = false
                result.onSuccess { (batch, backfilled) ->
                    val snapshot = synchronized(lock) {
                        reducer.updateOwnUserId(activeTransport.ownUserId)
                        requiresFullSync = false
                        sinceToken = batch.nextBatch
                        val delta = batch.roomDeltas[currentRoom]
                        if (delta != null) {
                            reducer.applySyncDelta(delta, backfilled)
                        } else {
                            batch.roomEvents[currentRoom]?.let(reducer::applyEvents)
                        }
                        reducer.messages()
                    }
                    messages = snapshot
                    plaintextAllowed = isConfidential == false && batch.plaintextAllowedRooms.contains(currentRoom)
                    syncStatusRes = if (plaintextAllowed) R.string.conversation_status_live else R.string.conversation_status_secure_transport_required
                }.onFailure {
                    plaintextAllowed = false
                    requiresFullSync = true
                    syncStatusRes = R.string.conversation_status_offline
                }
            }
        }
    }

    fun sendComposerMessage() {
        if (isCleared || !canSend) return
        val txnId = UuidV7Identifier.mint().toString()
        val outgoingBody = composerText
        val replyEventId = activeReplyTarget?.eventId
        val outgoingAttachments = stagedAttachments

        composerText = ""
        activeReplyTarget = null
        stagedAttachments = emptyList()

        val optimisticRefs = outgoingAttachments.mapNotNull { item ->
            runCatching {
                AttachmentMetadataRef.create(
                    id = UuidV7Identifier.mint().toString(),
                    filename = item.filename,
                    contentType = item.contentType,
                    sizeBytes = item.sizeBytes,
                )
            }.getOrNull()
        }

        val optimisticSnapshot = synchronized(lock) {
            reducer.enqueueOptimisticSend(
                transactionId = txnId,
                body = outgoingBody,
                replyToEventId = replyEventId,
                attachments = optimisticRefs,
                nowMs = System.currentTimeMillis(),
            )
            reducer.messages()
        }
        messages = optimisticSnapshot

        dispatchOutbound(
            transactionId = txnId,
            body = outgoingBody,
            replyToEventId = replyEventId,
            stagedPayloads = outgoingAttachments,
            uploadedRefs = emptyList(),
        )
    }

    fun retryFailedMessage(transactionId: String) {
        if (isCleared) return
        val failed = synchronized(lock) {
            val f = failedOutbounds[transactionId] ?: return
            reducer.markOptimisticRetrying(transactionId)
            f
        }
        messages = synchronized(lock) { reducer.messages() }
        dispatchOutbound(
            transactionId = transactionId,
            body = failed.body,
            replyToEventId = failed.replyToEventId,
            stagedPayloads = failed.stagedPayloads,
            uploadedRefs = failed.uploadedRefs,
        )
    }

    fun toggleReaction(message: MatrixTimelineMessage, emojiKey: String) {
        if (isConfidential != false || (transport != null && !plaintextAllowed)) return
        if (isCleared || !canReact(message) || !ReactionKeyValidator.isValid(emojiKey)) return
        val liveTargetEventId = message.eventId ?: return
        expandedReactionMessageKey = null
        val existing: MatrixReactionSummary? = message.reactions.firstOrNull { it.key == emojiKey }
        val existingOwnReactionId = existing?.myReactionEventId
        val activeTransport = transport
        val currentRoom = synchronized(lock) { roomId }

        if (activeTransport != null && currentRoom != null) {
            val txnId = UuidV7Identifier.mint().toString()
            workerExecutor.execute {
                if (isCleared) return@execute
                val result = runCatching {
                    if (existing != null && existing.isSelectedByMe && existingOwnReactionId != null) {
                        val redactId = activeTransport.redactEvent(currentRoom, txnId, existingOwnReactionId)
                        MatrixRawTimelineEvent(
                            type = "m.room.redaction",
                            eventId = redactId,
                            sender = activeTransport.ownUserId,
                            originServerTs = System.currentTimeMillis(),
                            redactsEventId = existingOwnReactionId,
                        )
                    } else {
                        val reactId = activeTransport.sendReaction(currentRoom, txnId, liveTargetEventId, emojiKey)
                        MatrixRawTimelineEvent(
                            type = "m.reaction",
                            eventId = reactId,
                            sender = activeTransport.ownUserId,
                            originServerTs = System.currentTimeMillis(),
                            relationType = "m.annotation",
                            relatesToEventId = liveTargetEventId,
                            reactionKey = emojiKey,
                        )
                    }
                }
                mainExecutor.execute {
                    if (isCleared) return@execute
                    result.onSuccess { syntheticEvent ->
                        messages = synchronized(lock) {
                            reducer.updateOwnUserId(activeTransport.ownUserId)
                            reducer.applyEvents(listOf(syntheticEvent))
                            reducer.messages()
                        }
                    }.onFailure {
                        syncStatusRes = R.string.conversation_status_offline
                    }
                }
            }
            return
        }

        // Local reaction state on an already-delivered message when operating without live Matrix transport.
        messages = synchronized(lock) {
            localReactionCounter += 1
            if (existing != null && existing.isSelectedByMe && existingOwnReactionId != null) {
                reducer.applyEvents(
                    listOf(
                        MatrixRawTimelineEvent(
                            type = "m.room.redaction",
                            eventId = "\$localRedact_$localReactionCounter",
                            sender = reducer.ownUserId,
                            originServerTs = System.currentTimeMillis(),
                            redactsEventId = existingOwnReactionId,
                        )
                    )
                )
            } else {
                reducer.applyEvents(
                    listOf(
                        MatrixRawTimelineEvent(
                            type = "m.reaction",
                            eventId = "\$localReact_$localReactionCounter",
                            sender = reducer.ownUserId,
                            originServerTs = System.currentTimeMillis(),
                            relationType = "m.annotation",
                            relatesToEventId = liveTargetEventId,
                            reactionKey = emojiKey,
                        )
                    )
                )
            }
            reducer.messages()
        }
    }

    fun clear() {
        cleared = true
        fence.invalidate()
        synchronized(lock) {
            bootstrapInFlight = false
            backgroundedDuringBootstrap = false
            syncInFlight = false
            reducer.clear()
            failedOutbounds.clear()
            roomId = null
            sinceToken = null
        }
        isSyncing = false
        messages = emptyList()
        composerText = ""
        activeReplyTarget = null
        stagedAttachments = emptyList()
        expandedReactionMessageKey = null
    }

    private fun dispatchOutbound(
        transactionId: String,
        body: String,
        replyToEventId: String?,
        stagedPayloads: List<AttachmentUploadPayload>,
        uploadedRefs: List<AttachmentMetadataRef>,
    ) {
        if (isConfidential != false || (transport != null && !plaintextAllowed)) return
        val activeTransport = transport
        val currentRoom = synchronized(lock) { roomId }
        if (activeTransport == null || currentRoom == null || isCleared) {
            if (isCleared) return
            val snapshot = synchronized(lock) {
                failedOutbounds[transactionId] = FailedOutbound(body, replyToEventId, stagedPayloads, uploadedRefs)
                reducer.markOptimisticFailed(transactionId)
                reducer.messages()
            }
            messages = snapshot
            syncStatusRes = R.string.conversation_status_offline
            return
        }

        workerExecutor.execute {
            if (isCleared) return@execute
            val completedRefs = ArrayList(uploadedRefs)
            val remaining = ArrayList(stagedPayloads)
            val result = runCatching {
                while (remaining.isNotEmpty()) {
                    fence.checkActive()
                    val next = remaining[0]
                    completedRefs.add(activeTransport.uploadAttachment(scope.organisationId, scope.channelId, next))
                    remaining.removeAt(0)
                }
                fence.checkActive()
                activeTransport.sendMessage(
                    roomId = currentRoom,
                    transactionId = transactionId,
                    body = body,
                    replyToEventId = replyToEventId,
                    attachments = completedRefs,
                )
            }
            mainExecutor.execute {
                if (isCleared) return@execute
                result.onSuccess { eventId ->
                    messages = synchronized(lock) {
                        reducer.updateOwnUserId(activeTransport.ownUserId)
                        failedOutbounds.remove(transactionId)
                        reducer.acknowledgeOptimisticSend(transactionId, eventId)
                        reducer.messages()
                    }
                    syncStatusRes = R.string.conversation_status_live
                }.onFailure {
                    messages = synchronized(lock) {
                        failedOutbounds[transactionId] = FailedOutbound(body, replyToEventId, remaining, completedRefs)
                        reducer.markOptimisticFailed(transactionId)
                        reducer.messages()
                    }
                    syncStatusRes = R.string.conversation_status_offline
                }
            }
        }
    }

    companion object {
        const val SYNC_POLL_INTERVAL_MS: Long = 4_000L

        /** Reactions are permitted only on unredacted messages acknowledged by the homeserver. */
        fun canReact(message: MatrixTimelineMessage): Boolean =
            !message.isRedacted &&
                message.deliveryStatus == MatrixDeliveryStatus.SENT &&
                message.eventId != null

        fun shareableText(message: MatrixTimelineMessage, channelName: String): String {
            if (message.isRedacted) return "#$channelName"
            val attachmentSummary = AttachmentMetadataRef.fallbackBody(message.attachments)
            return when {
                message.body.isNotEmpty() && attachmentSummary.isNotEmpty() ->
                    "#$channelName — ${message.senderDisplayName}: ${message.body}\n$attachmentSummary"
                message.body.isNotEmpty() ->
                    "#$channelName — ${message.senderDisplayName}: ${message.body}"
                else ->
                    "#$channelName — ${message.senderDisplayName}: $attachmentSummary"
            }
        }
    }
}

/**
 * Interactive *Dark Precision* Jetpack Compose channel conversation screen (`LazyColumn` with stable keys,
 * multiline composer, `OpenDocument` attachments, haptic swipe-to-reply, `>= 48dp` emoji reaction pills,
 * and native `ACTION_SEND` chooser via `StartActivityForResult`).
 */
@Composable
fun ChannelConversationScreen(
    controller: ChannelConversationController,
    onBack: () -> Unit,
) {
    val palette = LocalKoderaPalette.current
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val listState = rememberLazyListState()
    val shareTitle = stringResource(R.string.conversation_share_action)

    val shareLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) { }

    val documentLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument(),
    ) { uri: Uri? ->
        if (uri != null) {
            controller.stageAttachmentFromUri(context, uri)
        }
    }

    val isForeground by controller.isForeground.collectAsState()
    LaunchedEffect(controller, isForeground) {
        if (!isForeground || controller.isCleared || !controller.hasLiveTransport) return@LaunchedEffect
        if (!controller.isBootstrapped) {
            if (!controller.hasAttemptedBootstrap) {
                controller.bootstrap()
            }
        } else {
            controller.refreshSync()
        }
        while (isForeground && !controller.isCleared && controller.hasLiveTransport) {
            delay(ChannelConversationController.SYNC_POLL_INTERVAL_MS)
            if (isForeground && !controller.isCleared && controller.hasLiveTransport && controller.isBootstrapped) {
                controller.refreshSync()
            }
        }
    }

    LaunchedEffect(controller.messages.lastOrNull()?.key) {
        if (controller.messages.isNotEmpty()) {
            listState.animateScrollToItem(controller.messages.lastIndex)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = palette.page, contentColor = palette.ink) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing),
        ) {
            ConversationTopBar(
                controller = controller,
                onBack = onBack,
            )
            HorizontalDivider(color = palette.hairline)

            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = KoderaTokens.Space.s4),
                verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s3),
            ) {
                item(key = "header-spacer") {
                    Spacer(modifier = Modifier.heightIn(min = KoderaTokens.Space.s2))
                }
                if (controller.messages.isEmpty()) {
                    item(key = "empty-state") {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = KoderaTokens.Space.s8),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = stringResource(R.string.conversation_empty_timeline),
                                style = NativeTypography.body,
                                color = palette.ink3,
                            )
                        }
                    }
                } else {
                    items(
                        items = controller.messages,
                        key = { it.key },
                    ) { message ->
                        ConversationMessageItem(
                            message = message,
                            isReactionBarExpanded = controller.expandedReactionMessageKey == message.key,
                            onReply = {
                                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                controller.selectReplyTarget(message)
                            },
                            onToggleReactionBar = {
                                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                controller.toggleReactionBar(message.key)
                            },
                            onSelectEmoji = { emoji ->
                                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                controller.toggleReaction(message, emoji)
                            },
                            onShare = {
                                val text = ChannelConversationController.shareableText(
                                    message = message,
                                    channelName = controller.scope.channelName,
                                )
                                val sendIntent = Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(Intent.EXTRA_TEXT, text)
                                }
                                shareLauncher.launch(Intent.createChooser(sendIntent, shareTitle))
                            },
                            onRetrySend = { txnId ->
                                controller.retryFailedMessage(txnId)
                            },
                        )
                    }
                }
                item(key = "footer-spacer") {
                    Spacer(modifier = Modifier.heightIn(min = KoderaTokens.Space.s2))
                }
            }

            HorizontalDivider(color = palette.hairline)
            ConversationComposerBar(
                controller = controller,
                onPickAttachment = {
                    documentLauncher.launch(arrayOf("image/*", "application/pdf", "text/plain"))
                },
                onSend = {
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    controller.sendComposerMessage()
                },
            )
        }
    }
}

@Composable
private fun ConversationTopBar(
    controller: ChannelConversationController,
    onBack: () -> Unit,
) {
    val palette = LocalKoderaPalette.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.surface)
            .padding(horizontal = KoderaTokens.Space.s4, vertical = KoderaTokens.Space.s3),
        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s3),
        ) {
            OutlinedButton(
                onClick = onBack,
                modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
            ) {
                Text(
                    text = stringResource(R.string.conversation_back_to_channels),
                    style = NativeTypography.emphasis,
                    color = palette.accentInk,
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s1),
            ) {
                Text(
                    text = "#${controller.scope.channelName}",
                    style = NativeTypography.heading,
                    color = palette.ink,
                    modifier = Modifier.semantics { heading() },
                )
                Text(
                    text = stringResource(if (controller.isConfidential == false) controller.syncStatusRes else R.string.conversation_status_secure_transport_required),
                    style = NativeTypography.caption,
                    color = palette.ink3,
                )
            }
            OutlinedButton(
                onClick = controller::refreshSync,
                enabled = !controller.isSyncing,
                modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
            ) {
                Text(
                    text = stringResource(R.string.conversation_sync_refresh),
                    style = NativeTypography.caption,
                    color = palette.accentInk,
                )
            }
        }
        if (controller.scope.kind == ChannelKind.AUDIO) {
            CielBadgePill(
                label = stringResource(R.string.conversation_companion_audio_badge),
                containerColor = palette.tag2Bg,
                contentColor = palette.tag2Fg,
            )
        }
        if (controller.scope.channelTopic.isNotEmpty()) {
            Text(
                text = controller.scope.channelTopic,
                style = NativeTypography.caption,
                color = palette.ink2,
            )
        }
    }
}

@Composable
private fun ConversationMessageItem(
    message: MatrixTimelineMessage,
    isReactionBarExpanded: Boolean,
    onReply: () -> Unit,
    onToggleReactionBar: () -> Unit,
    onSelectEmoji: (String) -> Unit,
    onShare: () -> Unit,
    onRetrySend: (String) -> Unit,
) {
    val palette = LocalKoderaPalette.current
    val density = LocalDensity.current
    val maxSwipePx = with(density) { KoderaTokens.Space.s12.toPx() }
    val thresholdPx = maxSwipePx * 0.85f
    var dragOffsetPx by remember(message.key) { mutableFloatStateOf(0f) }
    var didTriggerSwipe by remember(message.key) { mutableStateOf(false) }

    val selectedDesc = stringResource(R.string.conversation_reaction_selected)
    val notSelectedDesc = stringResource(R.string.conversation_reaction_not_selected)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .offset { IntOffset(dragOffsetPx.roundToInt(), 0) }
            .clip(RoundedCornerShape(KoderaTokens.Radius.lg))
            .background(palette.surface)
            .border(BorderStroke(KoderaTokens.Space.s1 / 4, palette.borderSoft), RoundedCornerShape(KoderaTokens.Radius.lg))
            .pointerInput(message.key, message.isRedacted) {
                if (!message.isRedacted) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            dragOffsetPx = 0f
                            didTriggerSwipe = false
                        },
                        onDragCancel = {
                            dragOffsetPx = 0f
                            didTriggerSwipe = false
                        },
                        onHorizontalDrag = { _, dragAmount ->
                            val next = (dragOffsetPx + dragAmount).coerceIn(0f, maxSwipePx)
                            dragOffsetPx = next
                            if (next >= thresholdPx && !didTriggerSwipe) {
                                didTriggerSwipe = true
                                onReply()
                            }
                        },
                    )
                }
            }
            .padding(KoderaTokens.Space.s4),
        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
    ) {
        val preview = message.replyPreview
        if (preview != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            ) {
                Box(
                    modifier = Modifier
                        .width(KoderaTokens.Space.s1)
                        .heightIn(min = KoderaTokens.Space.s4)
                        .background(palette.action),
                )
                Text(
                    text = "${preview.sender}: ${preview.bodyExcerpt}",
                    style = NativeTypography.caption,
                    color = palette.ink2,
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text = message.senderDisplayName, style = NativeTypography.emphasis, color = palette.ink)
                if (message.isEdited && !message.isRedacted) {
                    Text(
                        text = stringResource(R.string.conversation_edited_badge),
                        style = NativeTypography.caption,
                        color = palette.ink3,
                    )
                }
            }
            when (message.deliveryStatus) {
                MatrixDeliveryStatus.SENDING -> Text(
                    text = stringResource(R.string.conversation_delivery_sending),
                    style = NativeTypography.caption,
                    color = palette.ink3,
                )
                MatrixDeliveryStatus.FAILED -> Text(
                    text = stringResource(R.string.conversation_delivery_failed),
                    style = NativeTypography.caption,
                    color = palette.badInk,
                )
                MatrixDeliveryStatus.SENT -> Unit
            }
        }

        if (message.isRedacted) {
            Text(
                text = stringResource(R.string.conversation_redacted_placeholder),
                style = NativeTypography.body,
                color = palette.ink3,
            )
        } else {
            if (message.body.isNotEmpty()) {
                Text(text = message.body, style = NativeTypography.body, color = palette.ink)
            }
            if (message.attachments.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s1)) {
                    for (ref in message.attachments) {
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(KoderaTokens.Radius.sm))
                                .background(palette.muted)
                                .padding(horizontal = KoderaTokens.Space.s3, vertical = KoderaTokens.Space.s2),
                        ) {
                            Text(
                                text = "${if (ref.contentType.isAudio) "🎤" else "📎"} ${ref.filename}",
                                style = NativeTypography.monoCaption,
                                color = palette.accentInk,
                            )
                        }
                    }
                }
            }
        }

        val reactionsAllowed = ChannelConversationController.canReact(message)

        if (message.reactions.isNotEmpty() && !message.isRedacted) {
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            ) {
                for (reaction in message.reactions) {
                    val pillShape = RoundedCornerShape(KoderaTokens.Radius.full)
                    Box(
                        modifier = Modifier
                            .widthIn(min = KoderaTokens.Space.s12)
                            .heightIn(min = KoderaTokens.Space.s12)
                            .clip(pillShape)
                            .background(if (reaction.isSelectedByMe) palette.accentSoft else palette.muted)
                            .border(
                                width = KoderaTokens.Space.s1 / 4,
                                color = if (reaction.isSelectedByMe) palette.action else palette.borderSoft,
                                shape = pillShape,
                            )
                            .semantics {
                                role = Role.Button
                                contentDescription = "${reaction.key} ${reaction.count}"
                                stateDescription = if (reaction.isSelectedByMe) selectedDesc else notSelectedDesc
                                selected = reaction.isSelectedByMe
                            }
                            .clickable(enabled = reactionsAllowed) { onSelectEmoji(reaction.key) }
                            .padding(horizontal = KoderaTokens.Space.s3),
                        contentAlignment = Alignment.Center,
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s1),
                        ) {
                            Text(text = reaction.key, style = NativeTypography.body)
                            Text(
                                text = reaction.count.toString(),
                                style = NativeTypography.monoCaption,
                                color = if (reaction.isSelectedByMe) palette.accentInk else palette.ink2,
                            )
                        }
                    }
                }
            }
        }

        if (isReactionBarExpanded && reactionsAllowed) {
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            ) {
                for (emoji in ReactionKeyValidator.QUICK_PALETTE) {
                    Box(
                        modifier = Modifier
                            .widthIn(min = KoderaTokens.Space.s12)
                            .heightIn(min = KoderaTokens.Space.s12)
                            .clip(RoundedCornerShape(KoderaTokens.Radius.md))
                            .background(palette.elevated)
                            .semantics {
                                role = Role.Button
                                contentDescription = emoji
                            }
                            .clickable { onSelectEmoji(emoji) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(text = emoji, style = NativeTypography.heading)
                    }
                }
            }
        }

        if (!message.isRedacted) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = onReply,
                    modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(
                        text = stringResource(R.string.conversation_reply_action),
                        style = NativeTypography.caption,
                        color = palette.ink2,
                    )
                }
                TextButton(
                    onClick = onToggleReactionBar,
                    enabled = reactionsAllowed,
                    modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(
                        text = stringResource(R.string.conversation_react_action),
                        style = NativeTypography.caption,
                        color = if (reactionsAllowed) palette.ink2 else palette.ink3,
                    )
                }
                TextButton(
                    onClick = onShare,
                    modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(
                        text = stringResource(R.string.conversation_share_action),
                        style = NativeTypography.caption,
                        color = palette.ink2,
                    )
                }
                val retryTxnId = message.transactionId
                if (message.deliveryStatus == MatrixDeliveryStatus.FAILED && retryTxnId != null) {
                    OutlinedButton(
                        onClick = { onRetrySend(retryTxnId) },
                        modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
                    ) {
                        Text(
                            text = stringResource(R.string.conversation_retry_send),
                            style = NativeTypography.caption,
                            color = palette.badInk,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationComposerBar(
    controller: ChannelConversationController,
    onPickAttachment: () -> Unit,
    onSend: () -> Unit,
) {
    val palette = LocalKoderaPalette.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.surface)
            .padding(horizontal = KoderaTokens.Space.s4, vertical = KoderaTokens.Space.s3),
        verticalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
    ) {
        val replyTarget = controller.activeReplyTarget
        if (replyTarget != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(KoderaTokens.Radius.md))
                    .background(palette.accentSoft)
                    .padding(horizontal = KoderaTokens.Space.s3, vertical = KoderaTokens.Space.s2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.conversation_replying_to),
                        style = NativeTypography.caption,
                        color = palette.accentInk,
                    )
                    Text(
                        text = "${replyTarget.senderDisplayName}: ${replyTarget.body}",
                        style = NativeTypography.caption,
                        color = palette.ink2,
                    )
                }
                TextButton(
                    onClick = controller::clearReplyTarget,
                    modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
                ) {
                    Text(
                        text = stringResource(R.string.conversation_cancel_reply),
                        style = NativeTypography.caption,
                        color = palette.accentInk,
                    )
                }
            }
        }

        if (controller.stagedAttachments.isNotEmpty()) {
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
            ) {
                controller.stagedAttachments.forEachIndexed { index, payload ->
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(KoderaTokens.Radius.md))
                            .background(palette.muted)
                            .padding(start = KoderaTokens.Space.s3, end = KoderaTokens.Space.s1),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "📎 ${payload.filename}",
                            style = NativeTypography.monoCaption,
                            color = palette.ink,
                        )
                        TextButton(
                            onClick = { controller.removeStagedAttachment(index) },
                            modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
                        ) {
                            Text(
                                text = stringResource(R.string.conversation_remove_attachment),
                                style = NativeTypography.caption,
                                color = palette.ink2,
                            )
                        }
                    }
                }
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(KoderaTokens.Space.s2),
        ) {
            OutlinedButton(
                onClick = onPickAttachment,
                modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
            ) {
                Text(
                    text = stringResource(R.string.conversation_attach_action),
                    style = NativeTypography.caption,
                    color = palette.accentInk,
                )
            }
            OutlinedTextField(
                value = controller.composerText,
                onValueChange = controller::updateComposerText,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = KoderaTokens.Space.s12),
                textStyle = NativeTypography.body,
                placeholder = {
                    Text(
                        text = stringResource(R.string.conversation_composer_placeholder),
                        style = NativeTypography.body,
                        color = palette.placeholder,
                    )
                },
                minLines = 1,
                maxLines = 6,
            )
            Button(
                onClick = onSend,
                enabled = controller.canSend,
                modifier = Modifier.heightIn(min = KoderaTokens.Space.s12),
                colors = ButtonDefaults.buttonColors(
                    containerColor = palette.action,
                    contentColor = palette.onInverse,
                ),
            ) {
                Text(
                    text = stringResource(R.string.conversation_send_action),
                    style = NativeTypography.emphasis,
                )
            }
        }
    }
}

private fun readPickedDocument(
    context: Context,
    uri: Uri,
    isCancelled: () -> Boolean = { false },
): AttachmentUploadPayload? {
    if (isCancelled()) return null
    val resolver = context.contentResolver
    val rawMime = resolver.getType(uri) ?: "application/octet-stream"
    val mime = AttachmentMimeType.fromWire(rawMime) ?: AttachmentMimeType.OCTET_STREAM
    var displayName = "attachment"
    runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0 && !cursor.isNull(idx)) {
                    displayName = cursor.getString(idx)
                }
            }
        }
    }
    if (isCancelled()) return null
    val bytes = runCatching {
        resolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(8_192)
            while (true) {
                if (isCancelled()) return null
                val n = input.read(buf)
                if (n < 0) break
                if (out.size() + n > AttachmentMetadataRef.MAX_SIZE_BYTES) return null
                out.write(buf, 0, n)
            }
            out.toByteArray()
        }
    }.getOrNull() ?: return null
    if (bytes.isEmpty() || isCancelled()) return null
    return runCatching { AttachmentUploadPayload(displayName, mime, bytes) }.getOrNull()
}
