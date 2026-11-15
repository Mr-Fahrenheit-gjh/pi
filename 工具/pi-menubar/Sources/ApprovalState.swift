import Foundation

struct ApprovalTarget: Hashable {
    let origin: String
    let sessionID: String
    let requestID: String
}

struct ApprovalRequest: Equatable {
    let method: String
    let title: String?
    let message: String?
    let options: [String]?
    let placeholder: String?
    let prefill: String?
    let expiresAt: Double?

    init(_ event: ApprovalEvent) {
        method = event.method ?? ""
        title = event.title
        message = event.message
        options = event.options
        placeholder = event.placeholder
        prefill = event.prefill
        expiresAt = event.expiresAt
    }

    var supportsNative: Bool {
        guard title != nil else { return false }
        switch method {
        case "select": return options != nil
        case "confirm": return message != nil
        case "input", "editor": return true
        default: return false
        }
    }
    func isExpired(at now: Date) -> Bool {
        expiresAt.map { !$0.isFinite || $0 <= now.timeIntervalSince1970 * 1000 } ?? false
    }

    func response(id: String, answer: ApprovalAnswer) -> ApprovalResponse? {
        guard supportsNative else { return nil }
        switch answer {
        case .cancel: return ApprovalResponse(id: id, cancelled: true)
        case .confirm(let value) where method == "confirm": return ApprovalResponse(id: id, confirmed: value)
        case .value(let value) where method == "input" || method == "editor": return ApprovalResponse(id: id, value: value)
        case .value(let value) where method == "select" && options?.contains(value) == true:
            return ApprovalResponse(id: id, value: value)
        default: return nil
        }
    }
}

enum ApprovalAnswer { case value(String), confirm(Bool), cancel }

struct ApprovalResponse: Encodable {
    let type = "extension_ui_response"
    let id: String
    var value: String? = nil
    var confirmed: Bool? = nil
    var cancelled: Bool? = nil
}

enum ApprovalPhase: Equatable {
    case syncing, ready, sending, sent, uncertain, expired
}

struct PendingApproval: Identifiable {
    let id: ApprovalTarget
    var request: ApprovalRequest
    var phase: ApprovalPhase
    let order: Int

    func canRespond(at now: Date) -> Bool {
        phase == .ready && request.supportsNative && !request.isExpired(at: now)
    }
}

struct ApprovalSubmission {
    let target: ApprovalTarget
    let generation: UUID
    let response: ApprovalResponse
}

/// A single SSE generation owns each session's snapshot and replay. Polling never enables a form.
/// Attempted IDs remain locked even after a lost response, closure, or replay; no automatic retry.
struct ApprovalState {
    private struct Connection { let generation: UUID; var ready = false }
    private var connections: [String: Connection] = [:]
    private(set) var pending: [ApprovalTarget: PendingApproval] = [:]
    private var attempts: [ApprovalTarget: ApprovalPhase] = [:]
    private var sequence = 0

    func requests(for sessionID: String) -> [PendingApproval] {
        pending.values.filter { $0.id.sessionID == sessionID }.sorted { $0.order < $1.order }
    }
    func isConnected(_ sessionID: String) -> Bool { connections[sessionID]?.ready == true }

    func shouldNotify(_ target: ApprovalTarget, generation: UUID, now: Date = Date()) -> Bool {
        guard let connection = connections[target.sessionID], connection.ready, connection.generation == generation,
              let item = pending[target] else { return false }
        // custom also needs attention, but expired or already-attempted questions do not.
        return item.phase == .ready && !item.request.isExpired(at: now)
    }

    mutating func beginConnection(_ sessionID: String) -> UUID {
        let generation = UUID()
        disconnect(sessionID)
        connections[sessionID] = Connection(generation: generation)
        return generation
    }

    mutating func disconnect(_ sessionID: String, generation: UUID? = nil) {
        if let generation, connections[sessionID]?.generation != generation { return }
        connections[sessionID] = nil
        for key in Array(pending.keys) where key.sessionID == sessionID && pending[key]?.phase == .ready {
            pending[key]?.phase = .syncing
        }
    }

    mutating func disconnectAll() {
        for id in Array(connections.keys) { disconnect(id) }
    }

    mutating func retainSessions(_ ids: Set<String>) {
        for id in Array(connections.keys) where !ids.contains(id) { disconnect(id) }
        pending = pending.filter { ids.contains($0.key.sessionID) }
        // Keep attempted IDs for this process lifetime, including when a session briefly stops awaiting.
    }

    mutating func receive(_ event: ApprovalEvent, origin: String, sessionID: String, generation: UUID, now: Date = Date()) {
        guard connections[sessionID]?.generation == generation else { return }
        if event.type == "connected" {
            guard event.sessionId == sessionID, let ids = event.pendingExtensionUiIds else {
                disconnect(sessionID, generation: generation)
                return
            }
            let snapshot = Set(ids)
            pending = pending.filter { $0.key.sessionID != sessionID || snapshot.contains($0.key.requestID) }
            for key in Array(pending.keys) where key.sessionID == sessionID && pending[key]?.phase == .ready {
                pending[key]?.phase = .syncing
            }
            connections[sessionID]?.ready = true
            return
        }
        if event.type == "startup_error" || event.type == "session_shutdown" {
            disconnect(sessionID, generation: generation)
            return
        }
        guard connections[sessionID]?.ready == true, let id = event.id, !id.isEmpty else { return }
        let target = ApprovalTarget(origin: origin, sessionID: sessionID, requestID: id)
        if event.type == "extension_ui_closed" || (event.type == "extension_ui_request" && event.method == "custom" && event.closed == true) {
            pending[target] = nil
            return
        }
        guard event.type == "extension_ui_request", event.closed != true,
              ["select", "confirm", "input", "editor", "custom"].contains(event.method ?? "") else { return }
        let request = ApprovalRequest(event)
        let phase = attempts[target] ?? (request.isExpired(at: now) ? .expired : .ready)
        sequence += 1
        pending[target] = PendingApproval(id: target, request: request, phase: phase, order: pending[target]?.order ?? sequence)
    }

    mutating func expire(at now: Date = Date()) {
        for key in Array(pending.keys) {
            guard let item = pending[key], item.request.isExpired(at: now),
                  item.phase == .ready || item.phase == .syncing else { continue }
            pending[key]?.phase = .expired
        }
    }

    mutating func beginSubmission(_ target: ApprovalTarget, answer: ApprovalAnswer, now: Date = Date()) -> ApprovalSubmission? {
        expire(at: now)
        guard let connection = connections[target.sessionID], connection.ready,
              let item = pending[target], item.canRespond(at: now), attempts[target] == nil,
              let response = item.request.response(id: target.requestID, answer: answer) else { return nil }
        pending[target]?.phase = .sending
        attempts[target] = .sending // Lock synchronously, before cookie lookup or any network await.
        return ApprovalSubmission(target: target, generation: connection.generation, response: response)
    }

    func maySend(_ submission: ApprovalSubmission, at now: Date = Date()) -> Bool {
        let connection = connections[submission.target.sessionID]
        guard connection?.ready == true, connection?.generation == submission.generation,
              let item = pending[submission.target], item.phase == .sending,
              !item.request.isExpired(at: now) else { return false }
        return true
    }

    mutating func finish(_ submission: ApprovalSubmission, receivedHTTPReply: Bool) {
        let phase: ApprovalPhase = receivedHTTPReply ? .sent : .uncertain
        attempts[submission.target] = phase
        if pending[submission.target] != nil { pending[submission.target]?.phase = phase }
        // A close only removes the form. Neither it nor HTTP 200 proves whose answer won.
    }
}
