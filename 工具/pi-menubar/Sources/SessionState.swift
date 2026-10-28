import Foundation

struct PiSession: Decodable, Identifiable {
    struct Relation: Decodable { let kind: String }
    let id: String
    let cwd: String
    let name: String?
    let firstMessage: String?
    let modified: String
    let relation: Relation?

    var isChild: Bool { relation?.kind == "subagent" }
    var title: String {
        let text = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let text, !text.isEmpty { return text }
        return String((firstMessage?.split(separator: "\n").first.map(String.init) ?? "未命名对话").prefix(100))
    }
    var project: String { URL(fileURLWithPath: cwd).lastPathComponent }
}

struct SharedReadState: Decodable, Equatable {
    static let maxSafeInteger: Int64 = 9_007_199_254_740_991
    let revision: Int64
    let unread: [String: Int64]

    private enum CodingKeys: String, CodingKey { case revision, unread }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        revision = try values.decode(Int64.self, forKey: .revision)
        unread = try values.decode([String: Int64].self, forKey: .unread)
        guard revision >= 0, revision <= Self.maxSafeInteger,
              unread.allSatisfy({ Self.validID($0.key) && $0.value > 0 && $0.value <= revision }) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid shared read-state snapshot"))
        }
    }

    static func validID(_ id: String) -> Bool {
        guard let range = id.range(of: "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$", options: .regularExpression) else { return false }
        return range == id.startIndex..<id.endIndex
    }
}

struct RunningSnapshot: Decodable {
    let sessionListVersion: Int?
    let runningSessionIds: [String]
    let awaitingInputSessionIds: [String]
    let completionNotificationSuppressedSessionIds: [String]?
    let sessionReadState: SharedReadState?

    init(sessionListVersion: Int?, runningSessionIds: [String], awaitingInputSessionIds: [String],
         completionNotificationSuppressedSessionIds: [String]?, sessionReadState: SharedReadState? = nil) {
        self.sessionListVersion = sessionListVersion
        self.runningSessionIds = runningSessionIds
        self.awaitingInputSessionIds = awaitingInputSessionIds
        self.completionNotificationSuppressedSessionIds = completionNotificationSuppressedSessionIds
        self.sessionReadState = sessionReadState
    }

    private enum CodingKeys: String, CodingKey {
        case sessionListVersion, runningSessionIds, awaitingInputSessionIds, completionNotificationSuppressedSessionIds, sessionReadState
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        sessionListVersion = try values.decodeIfPresent(Int.self, forKey: .sessionListVersion)
        runningSessionIds = try values.decode([String].self, forKey: .runningSessionIds)
        awaitingInputSessionIds = try values.decode([String].self, forKey: .awaitingInputSessionIds)
        completionNotificationSuppressedSessionIds = try values.decodeIfPresent([String].self, forKey: .completionNotificationSuppressedSessionIds)
        // Only an absent field means old Web. Null or malformed shared state is an error, never empty.
        sessionReadState = values.contains(.sessionReadState) ? try values.decode(SharedReadState.self, forKey: .sessionReadState) : nil
    }
}

struct SessionList: Decodable {
    let sessions: [PiSession]
    let sessionListVersion: Int?
}

enum SessionCategory: String, CaseIterable {
    case active = "进行中"
    case awaiting = "待审批"
    case unread = "未读"
}

struct SessionState {
    private(set) var running = Set<String>()
    private(set) var awaiting = Set<String>()
    private(set) var unread: Set<String>
    private(set) var sharedReadState: SharedReadState?
    private var hasSnapshot = false

    init(unread: Set<String> = []) { self.unread = unread }

    mutating func apply(_ snapshot: RunningSnapshot, sessions: [PiSession], visibleSession: String?) {
        let next = Set(snapshot.runningSessionIds)
        let known = Set(sessions.map(\.id))
        let children = Set(sessions.filter(\.isChild).map(\.id))
        let suppressed = Set(snapshot.completionNotificationSuppressedSessionIds ?? [])
        let previousRunning = running
        running = next.intersection(known)
        awaiting = Set(snapshot.awaitingInputSessionIds).intersection(next).intersection(known)
        if let shared = snapshot.sessionReadState {
            applyReadState(shared, sessions: sessions)
        }
        if sharedReadState != nil {
            refreshSharedUnread(sessions: sessions)
        } else {
            if hasSnapshot {
                unread.formUnion(previousRunning.subtracting(next).subtracting(children).subtracting(suppressed))
            }
            unread.subtract(next)
            unread.formIntersection(known)
            if let visibleSession { unread.remove(visibleSession) }
        }
        hasSnapshot = true
    }

    func recentHistory(in sessions: [PiSession], limit: Int) -> [PiSession] {
        Array(sessions.filter { !$0.isChild && !running.contains($0.id) }
            .sorted { $0.modified > $1.modified }.prefix(max(0, limit)))
    }

    func readToken(for id: String) -> Int64? {
        guard let sharedReadState else { return nil }
        return sharedReadState.unread[id] ?? 0
    }

    @discardableResult
    mutating func applyReadState(_ snapshot: SharedReadState, sessions: [PiSession]) -> Bool {
        if let current = sharedReadState, snapshot.revision <= current.revision { return false }
        sharedReadState = snapshot
        refreshSharedUnread(sessions: sessions)
        return true
    }

    private mutating func refreshSharedUnread(sessions: [PiSession]) {
        guard let sharedReadState else { return }
        let eligible = Set(sessions.filter { !$0.isChild }.map(\.id))
        unread = Set(sharedReadState.unread.keys).intersection(eligible).subtracting(running)
    }

    mutating func markRead(_ id: String) {
        // Local deletion remains only for old Web versions without shared state.
        guard sharedReadState == nil else { return }
        unread.remove(id)
    }
}

struct ApprovalEvent: Decodable {
    let type: String
    let id: String?
    let method: String?
    let closed: Bool?
    let expiresAt: Double?
    let sessionId: String?
    let pendingExtensionUiIds: [String]?
    let title: String?
    let message: String?
    let options: [String]?
    let placeholder: String?
    let prefill: String?

    var isOpenQuestion: Bool {
        type == "extension_ui_request" && closed != true && id != nil &&
        ["select", "confirm", "input", "editor", "custom"].contains(method ?? "") &&
        (expiresAt == nil || expiresAt! > Date().timeIntervalSince1970 * 1000)
    }
}

/// Scope all native traffic to this local Pi Web installation.
struct PiEndpoint {
    let base: URL
    init(_ value: String) throws {
        guard let url = URL(string: value), url.scheme == "http",
              ["127.0.0.1", "localhost", "[::1]"].contains(url.host ?? ""),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw URLError(.badURL) }
        base = url
    }
    func api(_ path: String) -> URL { base.appendingPathComponent(path) }
    func conversation(_ id: String? = nil) -> URL {
        var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "sidebar", value: "collapsed")]
        if let id { parts.queryItems?.append(URLQueryItem(name: "session", value: id)) }
        return parts.url!
    }
    func contains(_ url: URL) -> Bool {
        url.scheme == base.scheme && url.host == base.host && (url.port ?? 80) == (base.port ?? 80) &&
        url.user == nil && url.password == nil
    }
    func agentURL(_ sessionID: String, events: Bool = false) throws -> URL {
        let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        guard !sessionID.isEmpty, sessionID != ".", sessionID != "..", sessionID.count <= 200,
              sessionID.unicodeScalars.allSatisfy(safe.contains) else { throw URLError(.badURL) }
        let url = api("api/agent").appendingPathComponent(sessionID)
        return events ? url.appendingPathComponent("events") : url
    }
}
