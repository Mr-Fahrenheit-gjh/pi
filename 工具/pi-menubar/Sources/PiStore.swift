import AppKit
import SwiftUI
import WebKit
import UserNotifications

struct SessionReadTarget: Hashable {
    let origin: String
    let sessionID: String
    let token: Int64?
    let generation: UUID
}

@MainActor
final class PiStore: ObservableObject {
    typealias ResponseTransport = @MainActor (URLRequest) async throws -> (Data, URLResponse)
    typealias CookieProvider = @MainActor () async -> [HTTPCookie]
    typealias TerminalNotificationSender = @MainActor (String, String, String) async -> Bool
    typealias TerminalNotificationRemover = @MainActor ([String]) -> Void

    @Published private(set) var sessions: [PiSession] = []
    @Published private(set) var state: SessionState
    @Published private(set) var approvals: ApprovalState
    @Published private(set) var terminalSessions: [UUID: TerminalSession] = [:]
    @Published private(set) var terminalSubmissions: [TerminalTarget: TerminalSubmission] = [:]
    @Published private(set) var connectionError: String?
    @Published private(set) var connected = false
    @Published private(set) var notificationHint = ""
    @Published var navigationError: String?
    @Published var navigating = false
    @Published var category: SessionCategory = .active
    @Published var focusedSessionID: String?
    let endpoint: PiEndpoint
    var onChange: (() -> Void)?
    private let defaults: UserDefaults
    private let client: URLSession
    private let responseTransport: ResponseTransport?
    private let cookieProvider: CookieProvider
    private let terminalDirectory: String?
    private let terminalNotificationSender: TerminalNotificationSender?
    private let terminalNotificationRemover: TerminalNotificationRemover?
    private lazy var terminalBridge = TerminalBridgeClient(
        directory: terminalDirectory ?? (ProcessInfo.processInfo.environment["PI_MENUBAR_BRIDGE_DIR"] ?? "/tmp/pi-menubar-\(getuid())"),
        onEvent: { [weak self] event in self?.handleTerminalEvent(event) }
    )
    private var pollTask: Task<Void, Never>?
    private var streams: [String: Task<Void, Never>] = [:]
    private var streamTokens: [String: UUID] = [:]
    private var listVersion: Int?
    private var notified: [String]
    private var refreshing = false
    private var suspended = false
    private var readEpoch = UUID()
    private var nextPollDelay: Double = 2.5
    private var nextReadAt = Date.distantPast
    private var reading = Set<SessionReadTarget>()

    init(endpoint: PiEndpoint, defaults: UserDefaults = .standard, approvals: ApprovalState = ApprovalState(),
         cookieProvider: @escaping CookieProvider = { await WKWebsiteDataStore.default().httpCookieStore.allCookies() },
         responseTransport: ResponseTransport? = nil, terminalDirectory: String? = nil,
         terminalNotificationSender: TerminalNotificationSender? = nil,
         terminalNotificationRemover: TerminalNotificationRemover? = nil) {
        self.endpoint = endpoint
        self.defaults = defaults
        self.approvals = approvals
        self.cookieProvider = cookieProvider
        self.responseTransport = responseTransport
        self.terminalDirectory = terminalDirectory
        self.terminalNotificationSender = terminalNotificationSender
        self.terminalNotificationRemover = terminalNotificationRemover
        state = SessionState(unread: Set(defaults.stringArray(forKey: "unread") ?? []))
        notified = defaults.stringArray(forKey: "notifiedQuestions") ?? []
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 60
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        client = URLSession(configuration: config, delegate: LoopbackRedirectGuard(endpoint: endpoint), delegateQueue: nil)
    }

    var primarySessions: [PiSession] { sessions.filter { !$0.isChild || state.awaiting.contains($0.id) } }
    var active: [PiSession] { primarySessions.filter { state.running.contains($0.id) && !state.awaiting.contains($0.id) } }
    var awaiting: [PiSession] { primarySessions.filter { state.awaiting.contains($0.id) } }
    var terminalAwaiting: [TerminalSession] {
        let ordered = terminalSessions.values.filter { !$0.snapshot.prompts.isEmpty }
            .sorted { $0.snapshot.title.localizedStandardCompare($1.snapshot.title) == .orderedAscending }
        guard let id = focusedSessionID, let focused = ordered.first(where: { $0.id == id }) else { return ordered }
        return [focused] + ordered.filter { $0.id != id }
    }
    var awaitingCount: Int { awaiting.count + terminalAwaiting.count }
    var unread: [PiSession] { primarySessions.filter { state.unread.contains($0.id) } }
    var recentHistory: [PiSession] {
        category == .active ? state.recentHistory(in: sessions, limit: max(0, 5 - active.count)) : []
    }
    var visibleSessions: [PiSession] {
        switch category {
        case .active: return active
        case .awaiting:
            guard let id = focusedSessionID, let focused = awaiting.first(where: { $0.id == id }) else { return awaiting }
            return [focused] + awaiting.filter { $0.id != id }
        case .unread: return unread
        }
    }

    func startTerminalMonitoring() {
        guard !suspended else { return }
        terminalBridge.start()
    }

    func start() {
        guard pollTask == nil else { return }
        startTerminalMonitoring()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                do { try await Task.sleep(nanoseconds: UInt64(self.nextPollDelay * 1_000_000_000)) }
                catch { return }
            }
        }
        Task { await updateNotificationPermission(request: true) }
    }

    func stop() {
        suspend()
        pollTask?.cancel()
        pollTask = nil
        client.invalidateAndCancel()
    }

    func suspend() {
        suspended = true
        readEpoch = UUID()
        terminalBridge.stop()
        disconnectStreams()
    }

    func resume() {
        suspended = false
        readEpoch = UUID()
        startTerminalMonitoring()
        Task { await refresh() }
    }

    func readTarget(for id: String) -> SessionReadTarget? {
        guard !suspended, SharedReadState.validID(id) else { return nil }
        return SessionReadTarget(origin: endpoint.base.absoluteString, sessionID: id,
                                 token: state.readToken(for: id), generation: readEpoch)
    }

    @discardableResult
    func markRead(_ target: SessionReadTarget) -> Task<Void, Never>? {
        guard !suspended, target.origin == endpoint.base.absoluteString, target.generation == readEpoch,
              SharedReadState.validID(target.sessionID), !reading.contains(target) else { return nil }
        guard let token = target.token else {
            // A click captured before shared-state support arrived cannot clear a newer shared marker.
            if state.sharedReadState == nil {
                state.markRead(target.sessionID)
                persistUnread()
                onChange?()
            }
            return nil
        }
        guard token >= 0, token <= SharedReadState.maxSafeInteger else { return nil }
        reading.insert(target)
        return Task { [weak self] in
            guard let self else { return }
            defer { self.reading.remove(target); self.onChange?() }
            do {
                var req = try await self.request(self.endpoint.api("api/sessions/read-state"))
                try Task.checkCancellation()
                guard !self.suspended, target.generation == self.readEpoch else { return }
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONSerialization.data(withJSONObject: [
                    "action": "read", "entries": [["id": target.sessionID, "token": token]]
                ])
                let (data, response): (Data, URLResponse)
                if let send = self.responseTransport { (data, response) = try await send(req) }
                else { (data, response) = try await self.client.data(for: req) }
                guard !self.suspended, target.generation == self.readEpoch else { return }
                try self.check(response)
                struct Reply: Decodable { let state: SharedReadState }
                let reply = try JSONDecoder().decode(Reply.self, from: data)
                self.state.applyReadState(reply.state, sessions: self.sessions)
                self.persistUnread()
            } catch {
                guard !self.suspended, target.generation == self.readEpoch else { return }
                self.navigationError = "网页已打开，但已读状态同步失败；未读状态暂时保留"
                if (error as NSError).domain == "PiHTTP", [401, 403].contains((error as NSError).code) {
                    self.connectionError = error.localizedDescription
                    self.disconnectStreams()
                }
                // A lost response is uncertain. Only a later read poll reconciles; never retry this write.
            }
        }
    }

    private func persistUnread() {
        if state.sharedReadState != nil { defaults.removeObject(forKey: "unread") }
        else { defaults.set(Array(state.unread).sorted(), forKey: "unread") }
    }

    private func request(_ url: URL) async throws -> URLRequest {
        guard endpoint.contains(url) else { throw URLError(.badURL) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        req.httpShouldHandleCookies = false
        let cookies = PiCookies.applicable(await cookieProvider(), to: url)
        for (key, value) in HTTPCookie.requestHeaderFields(with: cookies) { req.setValue(value, forHTTPHeaderField: key) }
        return req
    }

    private func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, let url = http.url, endpoint.contains(url) else {
            throw URLError(.badServerResponse)
        }
        if http.statusCode == 429 {
            let delay = Double(http.value(forHTTPHeaderField: "Retry-After") ?? "30") ?? 30
            nextPollDelay = delay.isFinite ? min(300, max(30, delay)) : 30
            nextReadAt = Date().addingTimeInterval(nextPollDelay)
        }
        guard http.statusCode == 200 else {
            let message = [401, 403].contains(http.statusCode)
                ? "原生访问未获授权，请在网页处理"
                : "Pi Web 返回 HTTP \(http.statusCode)"
            throw NSError(domain: "PiHTTP", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    private func fetch<T: Decodable>(_ path: String) async throws -> T {
        let req = try await request(endpoint.api(path))
        let (data, response): (Data, URLResponse)
        if let send = responseTransport { (data, response) = try await send(req) }
        else { (data, response) = try await client.data(for: req) }
        try check(response)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func refresh() async {
        guard !refreshing, !suspended, Date() >= nextReadAt else { return }
        refreshing = true
        let epoch = readEpoch
        defer { refreshing = false }
        approvals.expire()
        do {
            let snapshot: RunningSnapshot = try await fetch("api/agent/running")
            guard epoch == readEpoch, !suspended else { return }
            if !connected || listVersion == nil || listVersion != snapshot.sessionListVersion ||
                !Set(snapshot.runningSessionIds).isSubset(of: Set(sessions.map(\.id))) {
                let list: SessionList = try await fetch("api/sessions")
                guard epoch == readEpoch, !suspended else { return }
                sessions = list.sessions.sorted { $0.modified > $1.modified }
                listVersion = list.sessionListVersion
            }
            // Merely viewing a question is not reading a completed conversation.
            state.apply(snapshot, sessions: sessions, visibleSession: nil)
            persistUnread()
            connected = true
            connectionError = nil
            nextPollDelay = 2.5
            reconcileStreams()
        } catch {
            guard epoch == readEpoch else { return }
            connected = false
            connectionError = (error as NSError).domain == "PiHTTP" ? error.localizedDescription : "无法连接本机 Pi Web · 将自动重试"
            if nextPollDelay < 5 { nextPollDelay = 5 }
            disconnectStreams()
        }
        onChange?()
    }

    private func disconnectStreams() {
        approvals.disconnectAll()
        for task in streams.values { task.cancel() }
        streams.removeAll()
        streamTokens.removeAll()
        onChange?()
    }

    private func reconcileStreams() {
        approvals.retainSessions(state.awaiting)
        for id in Array(streams.keys) where !state.awaiting.contains(id) {
            streams.removeValue(forKey: id)?.cancel()
            streamTokens[id] = nil
            let stale = notified.filter { $0.hasPrefix(id + ":") }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: stale)
        }
        for id in state.awaiting where streams[id] == nil {
            let token = approvals.beginConnection(id)
            streamTokens[id] = token
            streams[id] = Task { [weak self] in
                guard let self else { return }
                defer {
                    if self.streamTokens[id] == token {
                        self.approvals.disconnect(id, generation: token)
                        self.streams[id] = nil
                        self.streamTokens[id] = nil
                        self.onChange?()
                    }
                }
                do {
                    var req = try await self.request(self.endpoint.agentURL(id, events: true))
                    try Task.checkCancellation()
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    req.timeoutInterval = 45
                    let (bytes, response) = try await self.client.bytes(for: req)
                    guard self.streamTokens[id] == token, !self.suspended else { return }
                    try self.check(response)
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        guard self.streamTokens[id] == token else { return }
                        // Pi emits one JSON object per SSE data line. Comments are not readiness.
                        guard line.hasPrefix("data:"), line.utf8.count < 1_000_000,
                              let data = String(line.dropFirst(5)).data(using: .utf8),
                              let event = try? JSONDecoder().decode(ApprovalEvent.self, from: data) else { continue }
                        self.approvals.receive(event, origin: self.endpoint.base.absoluteString, sessionID: id, generation: token)
                        self.onChange?()
                        if let questionID = event.id {
                            if event.type == "extension_ui_closed" || (event.method == "custom" && event.closed == true) {
                                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id + ":" + questionID])
                            } else if event.isOpenQuestion {
                                Task { [weak self] in await self?.notifyQuestion(sessionID: id, questionID: questionID, generation: token) }
                            }
                        }
                    }
                } catch {
                    if self.streamTokens[id] == token, (error as NSError).domain == "PiHTTP",
                       [401, 403].contains((error as NSError).code) {
                        self.connectionError = error.localizedDescription
                    }
                    // Only the next read poll reconnects. Answers are never retried.
                }
            }
        }
    }

    @discardableResult
    func submit(_ target: ApprovalTarget, answer: ApprovalAnswer) -> Task<Void, Never>? {
        guard !suspended, target.origin == endpoint.base.absoluteString,
              let submission = approvals.beginSubmission(target, answer: answer) else { return nil }
        let notificationID = target.sessionID + ":" + target.requestID
        if notified.contains(notificationID) {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [notificationID])
        }
        return Task { [weak self] in
            guard let self else { return }
            do {
                var req = try await self.request(self.endpoint.agentURL(target.sessionID))
                guard self.approvals.maySend(submission), !self.suspended else { throw URLError(.cancelled) }
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONEncoder().encode(submission.response)
                let (data, response): (Data, URLResponse)
                if let send = self.responseTransport { (data, response) = try await send(req) }
                else { (data, response) = try await self.client.data(for: req) }
                try self.check(response)
                struct Reply: Decodable { let success: Bool }
                guard try JSONDecoder().decode(Reply.self, from: data).success else { throw URLError(.badServerResponse) }
                self.approvals.finish(submission, receivedHTTPReply: true)
            } catch {
                self.approvals.finish(submission, receivedHTTPReply: false)
                if (error as NSError).domain == "PiHTTP", [401, 403].contains((error as NSError).code) {
                    self.connectionError = error.localizedDescription
                    self.disconnectStreams()
                }
            }
            self.onChange?()
        }
    }

    private func notifyQuestion(sessionID: String, questionID: String, generation: UUID) async {
        let key = sessionID + ":" + questionID
        let target = ApprovalTarget(origin: endpoint.base.absoluteString, sessionID: sessionID, requestID: questionID)
        guard !notified.contains(key), approvals.shouldNotify(target, generation: generation), !suspended else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        if settings.authorizationStatus == .notDetermined { await updateNotificationPermission(request: true) }
        let permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard permission == .authorized || permission == .provisional else { return }
        guard !Task.isCancelled, !notified.contains(key), approvals.shouldNotify(target, generation: generation),
              !suspended else { return }
        notified.append(key)
        notified = Array(notified.suffix(512))
        defaults.set(notified, forKey: "notifiedQuestions")
        let content = UNMutableNotificationContent()
        content.title = "Pi · 待审批 / 回答"
        content.body = sessions.first { $0.id == sessionID }?.title ?? "有一段对话需要你处理"
        content.sound = .default
        content.userInfo = ["sessionId": sessionID]
        content.categoryIdentifier = "PI_APPROVAL"
        do {
            try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: key, content: content, trigger: nil))
            if !approvals.shouldNotify(target, generation: generation) || suspended {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [key])
            }
        } catch {
            notificationHint = "通知未发送，请检查系统通知设置"
            notified.removeAll { $0 == key }
            defaults.set(notified, forKey: "notifiedQuestions")
        }
    }

    func handleTerminalEvent(_ event: TerminalBridgeEvent) {
        switch event {
        case let .snapshot(snapshot, instance, generation):
            guard !suspended, snapshot.valid(for: instance) else { return }
            let previous = terminalSessions[instance]
            let newIDs = Set(snapshot.prompts.map(\.toolCallId))
            let removed = previous?.snapshot.prompts.filter { !newIDs.contains($0.toolCallId) } ?? []
            removeTerminalNotifications(removed.map { terminalNotificationKey(instance: instance, toolCallID: $0.toolCallId) })
            terminalSubmissions = terminalSubmissions.filter { target, _ in
                target.instance != instance || (target.generation == generation && newIDs.contains(target.toolCallID))
            }
            if snapshot.prompts.isEmpty {
                terminalSessions.removeValue(forKey: instance)
            } else {
                terminalSessions[instance] = TerminalSession(snapshot: snapshot, instance: instance, generation: generation, connected: true)
                for prompt in snapshot.prompts {
                    let target = TerminalTarget(instance: instance, generation: generation, sessionID: snapshot.sessionId, toolCallID: prompt.toolCallId)
                    Task { [weak self] in await self?.notifyTerminalQuestion(target) }
                }
            }
        case let .verdict(verdict, instance, generation):
            guard let session = terminalSessions[instance], session.generation == generation else { return }
            let target = TerminalTarget(instance: instance, generation: generation, sessionID: session.snapshot.sessionId, toolCallID: verdict.toolCallId)
            guard var submission = terminalSubmissions[target], submission.requestID == verdict.requestId else { return }
            if verdict.ok { submission.phase = .accepted }
            else if ["invalid_payload", "invalid_answer", "unsupported_host"].contains(verdict.code ?? "") { submission.phase = .rejected }
            else { submission.phase = .uncertain }
            terminalSubmissions[target] = submission
        case let .disconnected(instance, generation):
            guard var session = terminalSessions[instance], session.generation == generation else { return }
            session.connected = false
            terminalSessions[instance] = session
            for (target, var submission) in terminalSubmissions where target.instance == instance && target.generation == generation {
                if submission.phase == .sending { submission.phase = .uncertain; terminalSubmissions[target] = submission }
            }
        case let .closed(instance, generation):
            guard let session = terminalSessions[instance], session.generation == generation else { return }
            removeTerminalNotifications(session.snapshot.prompts.map { terminalNotificationKey(instance: instance, toolCallID: $0.toolCallId) })
            terminalSessions.removeValue(forKey: instance)
            terminalSubmissions = terminalSubmissions.filter { $0.key.instance != instance }
        }
        onChange?()
    }

    func dismissDisconnectedTerminal(_ instance: UUID) {
        guard let session = terminalSessions[instance], !session.connected else { return }
        removeTerminalNotifications(session.snapshot.prompts.map { terminalNotificationKey(instance: instance, toolCallID: $0.toolCallId) })
        terminalSessions.removeValue(forKey: instance)
        terminalSubmissions = terminalSubmissions.filter { $0.key.instance != instance }
        onChange?()
    }

    func submitTerminal(_ target: TerminalTarget, answers: [TerminalAnswer]? = nil, cancel: Bool = false) {
        guard !suspended, let session = terminalSessions[target.instance], session.connected,
              session.generation == target.generation, session.snapshot.sessionId == target.sessionID,
              let prompt = session.snapshot.prompts.first(where: { $0.toolCallId == target.toolCallID }), prompt.isRespondable,
              terminalSubmissions[target] == nil || terminalSubmissions[target]?.phase == .rejected,
              cancel ? answers == nil : (answers != nil && TerminalAnswerValidator.valid(answers!, questions: prompt.questions ?? [])) else { return }
        let requestID = UUID().uuidString
        terminalSubmissions[target] = TerminalSubmission(requestID: requestID, phase: .sending)
        let message = TerminalAnswerMessage(instanceId: session.snapshot.instanceId, sessionId: target.sessionID,
                                            toolCallId: target.toolCallID, requestId: requestID,
                                            answers: answers, cancel: cancel ? true : nil)
        if !terminalBridge.send(message, target: target) { terminalSubmissions[target]?.phase = .uncertain }
        onChange?()
    }

    private func terminalNotificationKey(instance: UUID, toolCallID: String) -> String {
        "terminal:" + instance.uuidString.lowercased() + ":" + toolCallID
    }

    private func isTerminalPending(_ target: TerminalTarget) -> Bool {
        guard !suspended, let session = terminalSessions[target.instance], session.connected,
              session.generation == target.generation, session.snapshot.sessionId == target.sessionID else { return false }
        return session.snapshot.prompts.contains { $0.toolCallId == target.toolCallID }
    }

    private func terminalQuestionExists(_ target: TerminalTarget) -> Bool {
        guard let session = terminalSessions[target.instance], session.snapshot.sessionId == target.sessionID else { return false }
        return session.snapshot.prompts.contains { $0.toolCallId == target.toolCallID }
    }

    private func removeTerminalNotifications(_ keys: [String]) {
        guard !keys.isEmpty else { return }
        let removed = Set(keys)
        notified.removeAll { removed.contains($0) }
        defaults.set(notified, forKey: "notifiedQuestions")
        if let remove = terminalNotificationRemover { remove(keys); return }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: keys)
        center.removeDeliveredNotifications(withIdentifiers: keys)
    }

    private func notifyTerminalQuestion(_ target: TerminalTarget) async {
        let key = terminalNotificationKey(instance: target.instance, toolCallID: target.toolCallID)
        guard !notified.contains(key), isTerminalPending(target), let session = terminalSessions[target.instance] else { return }
        if terminalNotificationSender == nil {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined { await updateNotificationPermission(request: true) }
            let permission = await center.notificationSettings().authorizationStatus
            guard permission == .authorized || permission == .provisional else { return }
        }
        guard !Task.isCancelled, !notified.contains(key), isTerminalPending(target) else { return }
        notified.append(key)
        notified = Array(notified.suffix(512))
        defaults.set(notified, forKey: "notifiedQuestions")
        let sent: Bool
        if let sender = terminalNotificationSender {
            sent = await sender(key, session.snapshot.title, session.id)
        } else {
            let content = UNMutableNotificationContent()
            content.title = "Pi · 终端待审批 / 回答"
            content.body = session.snapshot.title
            content.sound = .default
            content.userInfo = ["sessionId": session.id]
            content.categoryIdentifier = "PI_APPROVAL"
            do {
                try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: key, content: content, trigger: nil))
                sent = true
            } catch { sent = false }
        }
        if !sent {
            notificationHint = "通知未发送，请检查系统通知设置"
            notified.removeAll { $0 == key }
            defaults.set(notified, forKey: "notifiedQuestions")
            // A reconnect may have skipped this key while the old delivery was in flight.
            if let current = terminalSessions[target.instance], current.connected,
               current.generation != target.generation, terminalQuestionExists(target) {
                let replacement = TerminalTarget(instance: target.instance, generation: current.generation,
                                                 sessionID: target.sessionID, toolCallID: target.toolCallID)
                Task { [weak self] in await self?.notifyTerminalQuestion(replacement) }
            }
        } else if !terminalQuestionExists(target) {
            // Disconnect/reconnect alone does not resolve the question or invalidate its notification.
            removeTerminalNotifications([key])
        }
    }

    func updateNotificationPermission(request: Bool) async {
        let center = UNUserNotificationCenter.current()
        if request {
            do { _ = try await center.requestAuthorization(options: [.alert, .sound, .badge]) }
            catch { notificationHint = "通知权限请求失败"; return }
        }
        let settings = await center.notificationSettings()
        let enabled = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        if enabled && !notificationHint.isEmpty { disconnectStreams() }
        notificationHint = enabled ? "" : "通知未开启：在系统设置 → 通知中允许 Pi Menu Bar"
    }
}
