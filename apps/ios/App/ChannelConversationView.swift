import PhotosUI
import SwiftUI
import UIKit
import KoderaClient
import KoderaDomain

struct ChannelConversationScope: Equatable, Hashable, Identifiable, Sendable {
    let organisationId: String
    let channelId: String
    let channelName: String
    let channelTopic: String
    let kind: WorkspaceChannelKind
    let isConfidential: Bool?
    let roomState: WorkspaceChannelRoomState

    var id: String { "\(organisationId):\(channelId)" }

    init?(organisationId: String, channel: WorkspaceChannel) {
        guard TrustPolicy.canonicalNonNilUUID(organisationId),
              TrustPolicy.canonicalNonNilUUID(channel.id),
              channel.lifecycle == .active else {
            return nil
        }
        self.organisationId = organisationId
        self.channelId = channel.id
        self.channelName = channel.name
        self.channelTopic = channel.topic
        self.kind = channel.kind
        self.roomState = channel.roomState
        self.isConfidential = channel.isConfidential
    }
}

/// Session-fenced view model driving a single channel's live Matrix timeline, optimistic sends,
/// replies, single-grapheme reactions, and Core-scoped attachments.
@MainActor
final class ChannelConversationModel: ObservableObject {
    private struct FailedOutbound {
        let body: String
        let replyToEventId: String?
        let stagedPayloads: [AttachmentUploadPayload]
        let uploadedRefs: [AttachmentMetadataRef]
    }

    let scope: ChannelConversationScope
    let fence: SessionFence
    private let transport: (any ChannelConversationTransport)?
    private var reducer: MatrixTimelineReducer
    private var roomId: String?
    private var requiresFullSync = false
    private var sinceToken: String?
    private var failedOutbounds: [String: FailedOutbound] = [:]
    private var localReactionCounter: Int = 0
    private var syncLoopTask: Task<Void, Never>?
    private var actionTasks: [UUID: Task<Void, Never>] = [:]

    @Published private(set) var isConfidential: Bool?
    @Published private(set) var isForeground = true
    @Published private(set) var plaintextAllowed = false
    @Published private(set) var messages: [MatrixTimelineMessage] = []
    @Published var composerText: String = ""
    @Published var activeReplyTarget: MatrixTimelineMessage?
    @Published private(set) var stagedAttachments: [AttachmentUploadPayload] = []
    @Published var expandedReactionMessageKey: String?
    @Published private(set) var syncStateKey: String = "conversation.status_connecting"
    @Published private(set) var isSyncing: Bool = false

    init(
        scope: ChannelConversationScope,
        transport: (any ChannelConversationTransport)? = nil,
        ownUserId: String = "@me:kodera.local",
        fence: SessionFence = SessionFence(),
        initialForeground: Bool = true
    ) {
        self.scope = scope
        self.isConfidential = scope.isConfidential
        self.transport = transport
        self.fence = fence
        self.isForeground = initialForeground
        let effectiveUser = transport?.ownUserId ?? ownUserId
        self.reducer = MatrixTimelineReducer(ownUserId: effectiveUser)
    }

    static func canReact(to message: MatrixTimelineMessage) -> Bool {
        !message.isRedacted && message.deliveryStatus == .sent && message.eventId != nil
    }

    var hasLiveTransport: Bool {
        transport != nil
    }

    var canSend: Bool {
        !fence.isInvalidated
            && isForeground && (transport == nil || plaintextAllowed) && isConfidential == false
            && (!composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !stagedAttachments.isEmpty)
    }

    func launchFencedTask(_ operation: @escaping @MainActor () async -> Void) {
        guard !fence.isInvalidated else { return }
        let id = UUID()
        let task = Task { @MainActor [weak self] in
            defer { self?.actionTasks.removeValue(forKey: id) }
            guard let self, !self.fence.isInvalidated, !Task.isCancelled else { return }
            await operation()
        }
        actionTasks[id] = task
    }

    func updateChannelSecurity(isConfidential: Bool?) {
        guard self.isConfidential != isConfidential else { return }
        self.isConfidential = isConfidential
        plaintextAllowed = false
        syncStateKey = "conversation.status_secure_transport_required"
        launchFencedTask { [weak self] in
            guard let self else { return }
            await self.transport?.updateChannelSecurity(organisationId: self.scope.organisationId, channelId: self.scope.channelId, isConfidential: isConfidential)
        }
    }

    func setForeground(_ active: Bool) {
        guard isForeground != active else { return }
        isForeground = active
        if active { startSyncLoop() } else { stopSyncLoop() }
    }

    func startSyncLoop() {
        guard isForeground, syncLoopTask == nil, !fence.isInvalidated else { return }
        syncLoopTask = Task { [weak self] in await self?.runSyncLoop() }
    }

    func runSyncLoop(pollIntervalNanoseconds: UInt64 = 4_000_000_000) async {
        guard !fence.isInvalidated, isForeground else { return }
        if roomId == nil { await bootstrap() } else { await refreshSync() }
        guard transport != nil else { return }
        while !Task.isCancelled && !fence.isInvalidated {
            try? await Task.sleep(nanoseconds: pollIntervalNanoseconds)
            guard !Task.isCancelled, !fence.isInvalidated else { break }
            await refreshSync()
        }
    }

    func stopSyncLoop() {
        syncLoopTask?.cancel()
        syncLoopTask = nil
    }

    func bootstrap() async {
        guard !fence.isInvalidated, isForeground else { return }
        guard let transport else {
            syncStateKey = "conversation.status_offline"
            return
        }
        isSyncing = true
        syncStateKey = "conversation.status_connecting"
        defer { isSyncing = false }
        do {
            let bootstrapped = try await transport.bootstrapRoom(
                organisationId: scope.organisationId,
                channelId: scope.channelId
            )
            guard !fence.isInvalidated, !Task.isCancelled else { return }
            if reducer.ownUserId != transport.ownUserId {
                reducer = MatrixTimelineReducer(ownUserId: transport.ownUserId)
            }
            roomId = bootstrapped.roomId
            plaintextAllowed = isConfidential == false && bootstrapped.initialBatch.plaintextAllowedRooms.contains(bootstrapped.roomId)
            sinceToken = bootstrapped.initialBatch.nextBatch
            if let delta = bootstrapped.initialBatch.roomDeltas[bootstrapped.roomId] {
                reducer.applySyncDelta(delta)
                messages = reducer.messages
            } else if let roomEvents = bootstrapped.initialBatch.roomEvents[bootstrapped.roomId] {
                reducer.applyEvents(roomEvents)
                messages = reducer.messages
            }
            syncStateKey = plaintextAllowed ? "conversation.status_live" : "conversation.status_secure_transport_required"
        } catch {
            guard !fence.isInvalidated else { return }
            syncStateKey = "conversation.status_offline"
        }
    }

    func refreshSync() async {
        guard !fence.isInvalidated, isForeground else { return }
        guard let transport else {
            syncStateKey = "conversation.status_offline"
            return
        }
        guard let currentRoomId = roomId else {
            await bootstrap()
            return
        }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let batch = try await transport.syncRoom(roomId: currentRoomId, since: requiresFullSync ? nil : sinceToken)
            guard !fence.isInvalidated, !Task.isCancelled else { return }
            plaintextAllowed = isConfidential == false && batch.plaintextAllowedRooms.contains(currentRoomId)
            requiresFullSync = false
            sinceToken = batch.nextBatch
            if let delta = batch.roomDeltas[currentRoomId] {
                var backfilled: [MatrixRawTimelineEvent] = []
                if delta.limited, let prevBatch = delta.prevBatch, !prevBatch.isEmpty {
                    backfilled = (try? await transport.backfillRoomMessages(
                        roomId: currentRoomId,
                        fromToken: prevBatch,
                        limit: MatrixRoomClient.syncTimelineLimit
                    )) ?? []
                    guard !fence.isInvalidated, !Task.isCancelled else { return }
                }
                if delta.limited || !delta.events.isEmpty {
                    reducer.applySyncDelta(delta, backfilledEvents: backfilled)
                    messages = reducer.messages
                }
            }
            syncStateKey = plaintextAllowed ? "conversation.status_live" : "conversation.status_secure_transport_required"
        } catch {
            guard !fence.isInvalidated else { return }
            plaintextAllowed = false
            requiresFullSync = true
            syncStateKey = "conversation.status_offline"
        }
    }

    func selectReplyTarget(_ message: MatrixTimelineMessage) {
        guard !message.isRedacted else { return }
        activeReplyTarget = message
    }

    func clearReplyTarget() {
        activeReplyTarget = nil
    }

    func stageAttachment(_ payload: AttachmentUploadPayload) {
        guard isConfidential == false, transport == nil || plaintextAllowed else { return }
        guard stagedAttachments.count < AttachmentMetadataRef.maxRefsPerMessage else { return }
        stagedAttachments.append(payload)
    }

    func removeStagedAttachment(at index: Int) {
        guard stagedAttachments.indices.contains(index) else { return }
        stagedAttachments.remove(at: index)
    }

    func sendComposerMessage() async {
        guard canSend,
              let mintedTxn = (try? UuidV7Identifier.mint())?.description else {
            return
        }
        let outgoingBody = composerText
        let replyEventId = activeReplyTarget?.eventId
        let outgoingAttachments = stagedAttachments

        composerText = ""
        activeReplyTarget = nil
        stagedAttachments = []

        let optimisticRefs: [AttachmentMetadataRef] = outgoingAttachments.compactMap { item in
            guard let placeholderId = (try? UuidV7Identifier.mint())?.description else { return nil }
            return try? AttachmentMetadataRef(
                id: placeholderId,
                filename: item.filename,
                contentType: item.contentType,
                sizeBytes: item.data.count
            )
        }

        let nowMs = Int64(Date().timeIntervalSince1970 * 1000.0)
        _ = reducer.enqueueOptimisticSend(
            transactionId: mintedTxn,
            body: outgoingBody,
            replyToEventId: replyEventId,
            attachments: optimisticRefs,
            nowMs: nowMs
        )
        messages = reducer.messages

        await performOutboundSend(
            transactionId: mintedTxn,
            body: outgoingBody,
            replyToEventId: replyEventId,
            stagedPayloads: outgoingAttachments,
            uploadedRefs: []
        )
    }

    func retryFailedMessage(transactionId: String) async {
        guard isForeground, isConfidential == false, transport == nil || plaintextAllowed else { return }
        guard let failed = failedOutbounds[transactionId] else { return }
        reducer.markOptimisticRetrying(transactionId: transactionId)
        messages = reducer.messages
        await performOutboundSend(
            transactionId: transactionId,
            body: failed.body,
            replyToEventId: failed.replyToEventId,
            stagedPayloads: failed.stagedPayloads,
            uploadedRefs: failed.uploadedRefs
        )
    }

    func toggleReaction(on message: MatrixTimelineMessage, emojiKey: String) async {
        guard isConfidential == false, transport == nil || plaintextAllowed, !fence.isInvalidated,
              Self.canReact(to: message),
              let liveTargetEventId = message.eventId,
              ReactionKeyValidator.isValid(emojiKey) else {
            return
        }
        let existing = message.reactions.first(where: { $0.key == emojiKey })

        if let transport, let currentRoomId = roomId {
            guard let txnId = (try? UuidV7Identifier.mint())?.description else { return }
            do {
                if let existing, existing.isSelectedByMe, let myReactionId = existing.myReactionEventId {
                    let redactionId = try await transport.redactEvent(
                        roomId: currentRoomId,
                        transactionId: txnId,
                        targetEventId: myReactionId
                    )
                    guard !fence.isInvalidated, !Task.isCancelled else { return }
                    reducer.applyEvents([
                        MatrixRawTimelineEvent(
                            type: "m.room.redaction",
                            eventId: redactionId,
                            sender: transport.ownUserId,
                            originServerTs: Int64(Date().timeIntervalSince1970 * 1000.0),
                            redactsEventId: myReactionId
                        )
                    ])
                } else {
                    let reactionEventId = try await transport.sendReaction(
                        roomId: currentRoomId,
                        transactionId: txnId,
                        targetEventId: liveTargetEventId,
                        emojiKey: emojiKey
                    )
                    guard !fence.isInvalidated, !Task.isCancelled else { return }
                    reducer.applyEvents([
                        MatrixRawTimelineEvent(
                            type: "m.reaction",
                            eventId: reactionEventId,
                            sender: transport.ownUserId,
                            originServerTs: Int64(Date().timeIntervalSince1970 * 1000.0),
                            relationType: "m.annotation",
                            relatesToEventId: liveTargetEventId,
                            reactionKey: emojiKey
                        )
                    ])
                }
                messages = reducer.messages
            } catch {
                guard !fence.isInvalidated else { return }
                syncStateKey = "conversation.status_offline"
            }
            return
        }

        // Local reaction state on an already-confirmed message when operating without a live Matrix transport.
        localReactionCounter += 1
        if let existing, existing.isSelectedByMe, let myReactionId = existing.myReactionEventId {
            reducer.applyEvents([
                MatrixRawTimelineEvent(
                    type: "m.room.redaction",
                    eventId: "$localRedact_\(localReactionCounter)",
                    sender: reducer.ownUserId,
                    originServerTs: Int64(Date().timeIntervalSince1970 * 1000.0),
                    redactsEventId: myReactionId
                )
            ])
        } else {
            reducer.applyEvents([
                MatrixRawTimelineEvent(
                    type: "m.reaction",
                    eventId: "$localReact_\(localReactionCounter)",
                    sender: reducer.ownUserId,
                    originServerTs: Int64(Date().timeIntervalSince1970 * 1000.0),
                    relationType: "m.annotation",
                    relatesToEventId: liveTargetEventId,
                    reactionKey: emojiKey
                )
            ])
        }
        messages = reducer.messages
    }

    func ingestExternalEvents(_ events: [MatrixRawTimelineEvent]) {
        guard !fence.isInvalidated else { return }
        reducer.applyEvents(events)
        messages = reducer.messages
    }

    func clear() {
        fence.invalidate()
        syncLoopTask?.cancel()
        syncLoopTask = nil
        for (_, task) in actionTasks {
            task.cancel()
        }
        actionTasks.removeAll()
        reducer.clear()
        messages = []
        composerText = ""
        activeReplyTarget = nil
        stagedAttachments = []
        expandedReactionMessageKey = nil
        failedOutbounds.removeAll()
        roomId = nil
        sinceToken = nil
    }

    static func shareableText(for message: MatrixTimelineMessage, channelName: String) -> String {
        if message.isRedacted { return "#\(channelName)" }
        let attachmentSummary = AttachmentMetadataRef.fallbackBody(for: message.attachments)
        if !message.body.isEmpty && !attachmentSummary.isEmpty {
            return "#\(channelName) — \(message.senderDisplayName): \(message.body)\n\(attachmentSummary)"
        }
        if !message.body.isEmpty {
            return "#\(channelName) — \(message.senderDisplayName): \(message.body)"
        }
        return "#\(channelName) — \(message.senderDisplayName): \(attachmentSummary)"
    }

    private func performOutboundSend(
        transactionId: String,
        body: String,
        replyToEventId: String?,
        stagedPayloads: [AttachmentUploadPayload],
        uploadedRefs: [AttachmentMetadataRef]
    ) async {
        guard isConfidential == false, transport == nil || plaintextAllowed, !fence.isInvalidated else { return }
        guard let transport, let currentRoomId = roomId else {
            failedOutbounds[transactionId] = FailedOutbound(
                body: body,
                replyToEventId: replyToEventId,
                stagedPayloads: stagedPayloads,
                uploadedRefs: uploadedRefs
            )
            reducer.markOptimisticFailed(transactionId: transactionId)
            messages = reducer.messages
            syncStateKey = "conversation.status_offline"
            return
        }

        var completedRefs = uploadedRefs
        var remainingPayloads = stagedPayloads
        do {
            while !remainingPayloads.isEmpty {
                guard !fence.isInvalidated, !Task.isCancelled else { return }
                let nextPayload = remainingPayloads[0]
                let ref = try await transport.uploadAttachment(
                    organisationId: scope.organisationId,
                    channelId: scope.channelId,
                    payload: nextPayload
                )
                guard !fence.isInvalidated, !Task.isCancelled else { return }
                completedRefs.append(ref)
                remainingPayloads.removeFirst()
            }
            guard !fence.isInvalidated, !Task.isCancelled else { return }
            let eventId = try await transport.sendMessage(
                roomId: currentRoomId,
                transactionId: transactionId,
                body: body,
                replyToEventId: replyToEventId,
                attachments: completedRefs
            )
            guard !fence.isInvalidated, !Task.isCancelled else { return }
            failedOutbounds.removeValue(forKey: transactionId)
            reducer.acknowledgeOptimisticSend(transactionId: transactionId, eventId: eventId)
            messages = reducer.messages
            syncStateKey = plaintextAllowed ? "conversation.status_live" : "conversation.status_secure_transport_required"
        } catch {
            guard !fence.isInvalidated else { return }
            failedOutbounds[transactionId] = FailedOutbound(
                body: body,
                replyToEventId: replyToEventId,
                stagedPayloads: remainingPayloads,
                uploadedRefs: completedRefs
            )
            reducer.markOptimisticFailed(transactionId: transactionId)
            messages = reducer.messages
            syncStateKey = "conversation.status_offline"
        }
    }
}

/// Interactive *Dark Precision* native channel conversation view (`LazyVStack`, `60/120 Hz`,
/// swipe-to-reply + haptic feedback, `>= 44pt` reaction pills, `PhotosPicker`, and `ShareLink`).
@MainActor
struct ChannelConversationView: View {
    @ObservedObject var model: ChannelConversationModel
    let onBack: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var selectedPhotos: [PhotosPickerItem] = []

    private var palette: KoderaTokens.Palette {
        KoderaTokens.activePalette(for: colorScheme)
    }

    var body: some View {
        VStack(spacing: 0) {
            conversationHeader
            Divider().overlay(palette.hairline)
            timelineSection
            Divider().overlay(palette.hairline)
            composerSection
        }
        .font(NativeTypography.body)
        .foregroundStyle(palette.ink)
        .background(palette.page.ignoresSafeArea())
        .tint(palette.action)
        .onAppear { model.startSyncLoop() }
        .onDisappear {
            model.stopSyncLoop()
        }
        .onChange(of: selectedPhotos) { newItems in
            guard !newItems.isEmpty else { return }
            model.launchFencedTask {
                await loadSelectedPhotos(newItems)
                selectedPhotos = []
            }
        }
    }

    private var conversationHeader: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            HStack(alignment: .center, spacing: KoderaTokens.Space.s3) {
                Button(action: onBack) {
                    Label("conversation.back_to_channels", systemImage: "chevron.left")
                        .font(NativeTypography.emphasis)
                        .foregroundStyle(palette.accentInk)
                        .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(Text("conversation.back_to_channels"))

                VStack(alignment: .leading, spacing: KoderaTokens.Space.s1) {
                    HStack(spacing: KoderaTokens.Space.s2) {
                        Image(systemName: model.scope.kind == .audio ? "waveform" : "number")
                            .foregroundStyle(palette.ink2)
                            .accessibilityHidden(true)
                        Text(verbatim: model.scope.channelName)
                            .font(NativeTypography.heading)
                            .lineLimit(1)
                            .accessibilityAddTraits(.isHeader)
                    }
                    Text(LocalizedStringKey(model.isConfidential == false ? model.syncStateKey : "conversation.status_secure_transport_required"))
                        .font(NativeTypography.caption)
                        .foregroundStyle(palette.ink3)
                }

                Spacer(minLength: KoderaTokens.Space.s2)

                Button {
                    model.launchFencedTask { await model.refreshSync() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .foregroundStyle(palette.accentInk)
                        .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.bordered)
                .disabled(model.isSyncing)
                .accessibilityLabel(Text("conversation.sync_refresh"))
            }

            if model.scope.kind == .audio {
                Text("conversation.companion_audio_badge")
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.tag2Fg)
                    .padding(.horizontal, KoderaTokens.Space.s3)
                    .padding(.vertical, KoderaTokens.Space.s1)
                    .background(palette.tag2Bg, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.full))
            }
            if !model.scope.channelTopic.isEmpty {
                Text(verbatim: model.scope.channelTopic)
                    .font(NativeTypography.caption)
                    .foregroundStyle(palette.ink2)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, KoderaTokens.Space.s4)
        .padding(.vertical, KoderaTokens.Space.s3)
        .background(palette.surface)
    }

    private var timelineSection: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: KoderaTokens.Space.s3) {
                    if model.messages.isEmpty {
                        Text("conversation.empty_timeline")
                            .font(NativeTypography.body)
                            .foregroundStyle(palette.ink3)
                            .padding(.vertical, KoderaTokens.Space.s8)
                            .frame(maxWidth: .infinity, alignment: .center)
                    } else {
                        ForEach(model.messages, id: \.key) { message in
                            ConversationMessageRow(
                                message: message,
                                channelName: model.scope.channelName,
                                isReactionBarExpanded: model.expandedReactionMessageKey == message.key,
                                palette: palette,
                                onReply: {
                                    triggerHapticImpact()
                                    model.selectReplyTarget(message)
                                },
                                onToggleReactionBar: {
                                    triggerHapticImpact()
                                    if model.expandedReactionMessageKey == message.key {
                                        model.expandedReactionMessageKey = nil
                                    } else {
                                        model.expandedReactionMessageKey = message.key
                                    }
                                },
                                onSelectEmoji: { emoji in
                                    triggerHapticImpact()
                                    model.expandedReactionMessageKey = nil
                                    model.launchFencedTask { await model.toggleReaction(on: message, emojiKey: emoji) }
                                },
                                onRetrySend: { txnId in
                                    model.launchFencedTask { await model.retryFailedMessage(transactionId: txnId) }
                                }
                            )
                            .id(message.key)
                        }
                    }
                }
                .padding(.horizontal, KoderaTokens.Space.s4)
                .padding(.vertical, KoderaTokens.Space.s4)
                .frame(maxWidth: KoderaTokens.Space.shellDocumentMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages.last?.key) { latestKey in
                guard let latestKey else { return }
                withAnimation(.spring(
                    response: KoderaTokens.Motion.snappy.response,
                    dampingFraction: KoderaTokens.Motion.snappy.dampingRatio
                )) {
                    proxy.scrollTo(latestKey, anchor: .bottom)
                }
            }
        }
    }

    private var composerSection: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            if let replyTarget = model.activeReplyTarget {
                HStack(spacing: KoderaTokens.Space.s2) {
                    VStack(alignment: .leading, spacing: KoderaTokens.Space.s1) {
                        Text("conversation.replying_to")
                            .font(NativeTypography.caption)
                            .foregroundStyle(palette.accentInk)
                        Text(verbatim: "\(replyTarget.senderDisplayName): \(replyTarget.body)")
                            .font(NativeTypography.caption)
                            .foregroundStyle(palette.ink2)
                            .lineLimit(1)
                    }
                    Spacer(minLength: KoderaTokens.Space.s2)
                    Button(action: model.clearReplyTarget) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(palette.ink2)
                            .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("conversation.cancel_reply"))
                }
                .padding(.horizontal, KoderaTokens.Space.s3)
                .padding(.vertical, KoderaTokens.Space.s1)
                .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
            }

            if !model.stagedAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: KoderaTokens.Space.s2) {
                        ForEach(Array(model.stagedAttachments.enumerated()), id: \.offset) { index, item in
                            HStack(spacing: KoderaTokens.Space.s2) {
                                Text(verbatim: "📎 \(item.filename)")
                                    .font(NativeTypography.monoCaption)
                                    .foregroundStyle(palette.ink)
                                    .lineLimit(1)
                                Button {
                                    model.removeStagedAttachment(at: index)
                                } label: {
                                    Image(systemName: "xmark")
                                        .foregroundStyle(palette.ink2)
                                        .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(Text("conversation.remove_attachment"))
                            }
                            .padding(.leading, KoderaTokens.Space.s3)
                            .padding(.trailing, KoderaTokens.Space.s1)
                            .background(palette.muted, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
                        }
                    }
                }
            }

            let attachPalette = palette
            HStack(alignment: .bottom, spacing: KoderaTokens.Space.s2) {
                PhotosPicker(
                    selection: $selectedPhotos,
                    maxSelectionCount: 5,
                    matching: .any(of: [.images])
                ) {
                    Image(systemName: "paperclip")
                        .foregroundStyle(attachPalette.accentInk)
                        .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                        .background(attachPalette.muted, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
                }
                .accessibilityLabel(Text("conversation.attach_action"))

                TextField("conversation.composer_placeholder", text: $model.composerText, axis: .vertical)
                    .font(NativeTypography.body)
                    .lineLimit(1...6)
                    .padding(.horizontal, KoderaTokens.Space.s3)
                    .padding(.vertical, KoderaTokens.Space.s3)
                    .frame(minHeight: KoderaTokens.Space.s12)
                    .background(palette.sunken, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: KoderaTokens.Radius.md)
                            .stroke(palette.borderInput, lineWidth: 1)
                    )
                    .accessibilityLabel(Text("conversation.composer_label"))

                Button {
                    triggerHapticImpact()
                    model.launchFencedTask { await model.sendComposerMessage() }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(NativeTypography.emphasis)
                        .foregroundStyle(palette.onInverse)
                        .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.canSend)
                .accessibilityLabel(Text("conversation.send_action"))
            }
        }
        .padding(.horizontal, KoderaTokens.Space.s4)
        .padding(.vertical, KoderaTokens.Space.s3)
        .background(palette.surface)
    }

    private func loadSelectedPhotos(_ items: [PhotosPickerItem]) async {
        for (idx, item) in items.enumerated() {
            guard let rawData = try? await item.loadTransferable(type: Data.self),
                  !rawData.isEmpty else {
                continue
            }
            let mime = Self.sniffImageMimeType(rawData)
            let ext: String
            switch mime {
            case .png: ext = "png"
            case .webp: ext = "webp"
            case .gif: ext = "gif"
            default: ext = "jpg"
            }
            if let payload = try? AttachmentUploadPayload(
                filename: "media-\(idx + 1).\(ext)",
                contentType: mime,
                data: rawData
            ) {
                model.stageAttachment(payload)
            }
        }
    }

    private static func sniffImageMimeType(_ data: Data) -> AttachmentMimeType {
        let prefix = Array(data.prefix(12))
        if prefix.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return .png }
        if prefix.starts(with: [0xFF, 0xD8, 0xFF]) { return .jpeg }
        if prefix.starts(with: [0x47, 0x49, 0x46, 0x38]) { return .gif }
        if prefix.count >= 12,
           prefix[0...3] == [0x52, 0x49, 0x46, 0x46],
           prefix[8...11] == [0x57, 0x45, 0x42, 0x50] {
            return .webp
        }
        return .jpeg
    }

    private func triggerHapticImpact() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

@MainActor
private struct ConversationMessageRow: View {
    let message: MatrixTimelineMessage
    let channelName: String
    let isReactionBarExpanded: Bool
    let palette: KoderaTokens.Palette
    let onReply: () -> Void
    let onToggleReactionBar: () -> Void
    let onSelectEmoji: (String) -> Void
    let onRetrySend: (String) -> Void

    @State private var swipeOffset: CGFloat = 0
    @State private var didTriggerSwipeHaptic = false

    private let swipeReplyThreshold: CGFloat = 48.0

    var body: some View {
        VStack(alignment: .leading, spacing: KoderaTokens.Space.s2) {
            if let preview = message.replyPreview {
                HStack(spacing: KoderaTokens.Space.s2) {
                    Rectangle()
                        .fill(palette.action)
                        .frame(width: KoderaTokens.Space.s1)
                    Text(verbatim: "\(preview.sender): \(preview.bodyExcerpt)")
                        .font(NativeTypography.caption)
                        .foregroundStyle(palette.ink2)
                        .lineLimit(1)
                }
                .padding(.vertical, KoderaTokens.Space.s1)
            }

            HStack(alignment: .firstTextBaseline, spacing: KoderaTokens.Space.s2) {
                Text(verbatim: message.senderDisplayName)
                    .font(NativeTypography.emphasis)
                    .foregroundStyle(palette.ink)
                if message.isEdited && !message.isRedacted {
                    Text("conversation.edited_badge")
                        .font(NativeTypography.caption)
                        .foregroundStyle(palette.ink3)
                }
                Spacer(minLength: KoderaTokens.Space.s2)
                deliveryStatusView
            }

            if message.isRedacted {
                Text("conversation.redacted_placeholder")
                    .font(NativeTypography.body)
                    .foregroundStyle(palette.ink3)
            } else {
                if !message.body.isEmpty {
                    Text(verbatim: message.body)
                        .font(NativeTypography.body)
                        .foregroundStyle(palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !message.attachments.isEmpty {
                    VStack(alignment: .leading, spacing: KoderaTokens.Space.s1) {
                        ForEach(message.attachments, id: \.id) { ref in
                            Text(verbatim: "\(ref.contentType.isAudio ? "🎤" : "📎") \(ref.filename)")
                                .font(NativeTypography.monoCaption)
                                .foregroundStyle(palette.accentInk)
                                .padding(.horizontal, KoderaTokens.Space.s3)
                                .padding(.vertical, KoderaTokens.Space.s2)
                                .background(palette.muted, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.sm))
                        }
                    }
                }
            }

            if !message.reactions.isEmpty && !message.isRedacted {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: KoderaTokens.Space.s2) {
                        ForEach(message.reactions, id: \.key) { reaction in
                            Button {
                                onSelectEmoji(reaction.key)
                            } label: {
                                HStack(spacing: KoderaTokens.Space.s1) {
                                    Text(verbatim: reaction.key)
                                        .font(NativeTypography.body)
                                    Text(verbatim: "\(reaction.count)")
                                        .font(NativeTypography.monoCaption)
                                        .foregroundStyle(reaction.isSelectedByMe ? palette.accentInk : palette.ink2)
                                }
                                .padding(.horizontal, KoderaTokens.Space.s3)
                                .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                                .background(
                                    reaction.isSelectedByMe ? palette.accentSoft : palette.muted,
                                    in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.full)
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: KoderaTokens.Radius.full)
                                        .stroke(reaction.isSelectedByMe ? palette.action : palette.borderSoft, lineWidth: 1)
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(verbatim: "\(reaction.key) \(reaction.count)"))
                            .accessibilityValue(
                                Text(LocalizedStringKey(
                                    reaction.isSelectedByMe
                                        ? "conversation.reaction_selected"
                                        : "conversation.reaction_not_selected"
                                ))
                            )
                            .accessibilityAddTraits(reaction.isSelectedByMe ? [.isSelected] : [])
                        }
                    }
                }
            }

            if isReactionBarExpanded && ChannelConversationModel.canReact(to: message) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: KoderaTokens.Space.s2) {
                        ForEach(ReactionKeyValidator.quickPalette, id: \.self) { emoji in
                            Button {
                                onSelectEmoji(emoji)
                            } label: {
                                Text(verbatim: emoji)
                                    .font(NativeTypography.heading)
                                    .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                                    .background(palette.elevated, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.md))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(verbatim: emoji))
                        }
                    }
                }
            }

            if !message.isRedacted {
                let canReact = ChannelConversationModel.canReact(to: message)
                HStack(spacing: KoderaTokens.Space.s2) {
                    Button(action: onReply) {
                        Label("conversation.reply_action", systemImage: "arrowshape.turn.up.left")
                            .font(NativeTypography.caption)
                            .foregroundStyle(palette.ink2)
                            .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                            .padding(.horizontal, KoderaTokens.Space.s2)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    Button(action: onToggleReactionBar) {
                        Label("conversation.react_action", systemImage: "face.smiling")
                            .font(NativeTypography.caption)
                            .foregroundStyle(canReact ? palette.ink2 : palette.ink3)
                            .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                            .padding(.horizontal, KoderaTokens.Space.s2)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canReact)

                    ShareLink(item: ChannelConversationModel.shareableText(for: message, channelName: channelName)) {
                        Label("conversation.share_action", systemImage: "square.and.arrow.up")
                            .font(NativeTypography.caption)
                            .foregroundStyle(palette.ink2)
                            .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                            .padding(.horizontal, KoderaTokens.Space.s2)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if message.deliveryStatus == .failed, let txnId = message.transactionId {
                        Button {
                            onRetrySend(txnId)
                        } label: {
                            Label("conversation.retry_send", systemImage: "arrow.clockwise")
                                .font(NativeTypography.caption)
                                .foregroundStyle(palette.badInk)
                                .frame(minWidth: KoderaTokens.Space.s12, minHeight: KoderaTokens.Space.s12)
                                .padding(.horizontal, KoderaTokens.Space.s2)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
        .padding(KoderaTokens.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: KoderaTokens.Radius.lg)
                .stroke(palette.borderSoft, lineWidth: 1)
        )
        .offset(x: swipeOffset)
        .gesture(
            DragGesture(minimumDistance: 20, coordinateSpace: .local)
                .onChanged { value in
                    guard !message.isRedacted, value.translation.width > 0,
                          abs(value.translation.width) > abs(value.translation.height) else {
                        return
                    }
                    swipeOffset = min(value.translation.width, KoderaTokens.Space.s12)
                    if swipeOffset >= swipeReplyThreshold && !didTriggerSwipeHaptic {
                        didTriggerSwipeHaptic = true
                        onReply()
                    }
                }
                .onEnded { _ in
                    didTriggerSwipeHaptic = false
                    withAnimation(.spring(
                        response: KoderaTokens.Motion.snappy.response,
                        dampingFraction: KoderaTokens.Motion.snappy.dampingRatio
                    )) {
                        swipeOffset = 0
                    }
                }
        )
    }

    @ViewBuilder
    private var deliveryStatusView: some View {
        switch message.deliveryStatus {
        case .sending:
            Text("conversation.delivery_sending")
                .font(NativeTypography.caption)
                .foregroundStyle(palette.ink3)
        case .failed:
            Text("conversation.delivery_failed")
                .font(NativeTypography.caption)
                .foregroundStyle(palette.badInk)
        case .sent:
            EmptyView()
        }
    }
}
