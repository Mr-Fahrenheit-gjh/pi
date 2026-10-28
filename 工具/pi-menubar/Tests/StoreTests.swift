import Foundation

@main struct StoreTests {
    @MainActor static func main() async throws {
        var checks = 0
        func check(_ value: Bool, _ name: String) { precondition(value, name); checks += 1 }
        let endpoint = try PiEndpoint("http://127.0.0.1:30141")
        let target = ApprovalTarget(origin: endpoint.base.absoluteString, sessionID: "session-a", requestID: "request-a")
        let suite = "cn.pi.menubar.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        func prepared() throws -> ApprovalState {
            var state = ApprovalState()
            let generation = state.beginConnection(target.sessionID)
            for json in [
                "{\"type\":\"connected\",\"sessionId\":\"session-a\",\"pendingExtensionUiIds\":[\"request-a\"]}",
                "{\"type\":\"extension_ui_request\",\"id\":\"request-a\",\"method\":\"select\",\"title\":\"选择\",\"options\":[\" 原始答案 \",\"B\"]}"
            ] {
                let event = try JSONDecoder().decode(ApprovalEvent.self, from: Data(json.utf8))
                state.receive(event, origin: target.origin, sessionID: target.sessionID, generation: generation)
            }
            return state
        }
        func reply(_ request: URLRequest, status: Int = 200, body: String = "{\"success\":true,\"data\":null}") -> (Data, URLResponse) {
            (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }

        var requests: [URLRequest] = []
        let store = PiStore(endpoint: endpoint, defaults: defaults, approvals: try prepared(), cookieProvider: { [] }, responseTransport: { request in
            requests.append(request)
            return reply(request)
        })
        let task = store.submit(target, answer: .value(" 原始答案 "))
        check(task != nil && store.approvals.pending[target]?.phase == .sending, "submission locks before any await")
        check(store.submit(target, answer: .cancel) == nil, "rapid click/cancel race sends at most once")
        store.focusedSessionID = "session-b"
        store.category = .unread
        await task?.value
        check(requests.count == 1, "one network request after multiple clicks")
        let request = requests[0]
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        check(request.httpMethod == "POST" && request.url?.path == "/api/agent/session-a", "target cannot follow current selection")
        check(body["id"] as? String == "request-a" && body["value"] as? String == " 原始答案 ", "captured UI id and original option preserved")
        check(store.approvals.pending[target]?.phase == .sent, "HTTP reply is not an acceptance claim")
        check(store.submit(target, answer: .value("B")) == nil, "HTTP 200 cannot unlock retry")
        let foreign = ApprovalTarget(origin: "http://127.0.0.1:30142", sessionID: target.sessionID, requestID: target.requestID)
        check(store.submit(foreign, answer: .value("B")) == nil, "foreign endpoint rejected")
        store.stop()

        for status in [401, 403, 429, 500, 302] {
            var count = 0
            let failing = PiStore(endpoint: endpoint, defaults: defaults, approvals: try prepared(), cookieProvider: { [] }, responseTransport: { request in
                count += 1
                return reply(request, status: status)
            })
            await failing.submit(target, answer: .value("B"))?.value
            check(failing.approvals.pending[target]?.phase == .uncertain, "HTTP \(status) is uncertain, never auto-reenabled")
            check(failing.submit(target, answer: .cancel) == nil && count == 1, "HTTP \(status) has no write retry")
            if status == 401 || status == 403 {
                check(failing.connectionError?.contains("网页处理") == true && !failing.approvals.isConnected(target.sessionID), "auth denial disables native approvals and offers browser fallback")
            }
            failing.stop()
        }
        for invalid in ["not JSON", "{\"success\":false}", "{}"] {
            var count = 0
            let malformed = PiStore(endpoint: endpoint, defaults: defaults, approvals: try prepared(), cookieProvider: { [] }, responseTransport: { request in
                count += 1
                return reply(request, body: invalid)
            })
            await malformed.submit(target, answer: .value("B"))?.value
            check(malformed.approvals.pending[target]?.phase == .uncertain && count == 1, "unrecognized response remains uncertain")
            check(malformed.submit(target, answer: .cancel) == nil, "malformed reply cannot retry")
            malformed.stop()
        }
        var lostCount = 0
        let lost = PiStore(endpoint: endpoint, defaults: defaults, approvals: try prepared(), cookieProvider: { [] }, responseTransport: { _ in
            lostCount += 1 // Models a server that accepted a response, but the reply was lost.
            throw URLError(.timedOut)
        })
        await lost.submit(target, answer: .value("B"))?.value
        check(lostCount == 1 && lost.approvals.pending[target]?.phase == .uncertain, "lost response stays locked")
        check(lost.submit(target, answer: .cancel) == nil, "no repeat even after a timeout")
        lost.stop()

        var duringCookie: (() -> Void)?
        var sleepCount = 0
        let sleeping = PiStore(endpoint: endpoint, defaults: defaults, approvals: try prepared(), cookieProvider: {
            duringCookie?()
            return []
        }, responseTransport: { request in sleepCount += 1; return reply(request) })
        duringCookie = { [weak sleeping] in sleeping?.suspend() }
        await sleeping.submit(target, answer: .value("B"))?.value
        check(sleepCount == 0 && sleeping.approvals.pending[target]?.phase == .uncertain, "sleep during auth lookup prevents write")
        check(sleeping.submit(target, answer: .cancel) == nil, "suspended client cannot answer")
        sleeping.stop()
        duringCookie = nil

        let sessionList = "{\"sessions\":[{\"id\":\"session-a\",\"cwd\":\"/p\",\"modified\":\"2026-10-26\"},{\"id\":\"session-b\",\"cwd\":\"/p\",\"modified\":\"2026-10-26\"}],\"sessionListVersion\":1}"
        var sharedJSON = "{\"revision\":1,\"unread\":{\"session-a\":1}}"
        var readReply = "{\"state\":{\"revision\":2,\"unread\":{\"session-a\":2}}}"
        var readStatus = 200
        var loseReadReply = false
        var readRequests: [URLRequest] = []
        var beforeReadReply: (() async -> Void)?
        var beforeSharedCookie: (() -> Void)?
        defaults.set(["session-b"], forKey: "unread")
        let synced = PiStore(endpoint: endpoint, defaults: defaults, cookieProvider: {
            beforeSharedCookie?()
            return []
        }, responseTransport: { request in
            if request.httpMethod == "POST" {
                readRequests.append(request)
                await beforeReadReply?()
                if loseReadReply { throw URLError(.timedOut) }
                return reply(request, status: readStatus, body: readReply)
            }
            if request.url?.path == "/api/sessions" { return reply(request, body: sessionList) }
            return reply(request, body: "{\"sessionListVersion\":1,\"runningSessionIds\":[],\"awaitingInputSessionIds\":[],\"sessionReadState\":\(sharedJSON)}")
        })
        await synced.refresh()
        check(synced.connected && synced.state.unread == ["session-a"], "first shared poll replaces native legacy state")
        check(defaults.object(forKey: "unread") == nil, "native legacy unread is removed, never imported to the server")
        let oldRead = synced.readTarget(for: "session-a")!
        check(oldRead.token == 1, "navigation captures the current completion token")
        sharedJSON = "{\"revision\":2,\"unread\":{\"session-a\":2}}"
        await synced.refresh() // Another completion arrived while Chrome was opening.
        let oldReadTask = synced.markRead(oldRead)
        check(oldReadTask != nil && synced.markRead(oldRead) == nil, "one read write in flight per captured target")
        await oldReadTask?.value
        let readRequest = readRequests[0]
        let readBody = try JSONSerialization.jsonObject(with: readRequest.httpBody!) as! [String: Any]
        let entries = readBody["entries"] as! [[String: Any]]
        check(readRequest.url?.path == "/api/sessions/read-state" && readRequest.value(forHTTPHeaderField: "Content-Type") == "application/json", "read acknowledgement uses same-origin typed API")
        check(readBody["action"] as? String == "read" && entries[0]["id"] as? String == "session-a" && (entries[0]["token"] as? NSNumber)?.int64Value == 1, "navigation completion never substitutes the newer token")
        check(synced.state.unread == ["session-a"] && synced.state.readToken(for: "session-a") == 2, "stale-token response preserves newer unread")
        readReply = "{\"state\":{\"revision\":3,\"unread\":{}}}"
        let readTask = synced.markRead(synced.readTarget(for: "session-a")!)
        check(synced.state.unread == ["session-a"], "native read is not cleared optimistically")
        await readTask?.value
        check(synced.state.unread.isEmpty, "successful shared acknowledgement clears native unread")

        sharedJSON = "{\"revision\":4,\"unread\":{\"session-a\":4}}"
        await synced.refresh()
        check(synced.state.unread == ["session-a"], "a later completion appears again")
        sharedJSON = "{\"revision\":5,\"unread\":{}}"
        await synced.refresh()
        check(synced.state.unread.isEmpty && readRequests.count == 2, "Web read clears native on poll without a native click or write")

        sharedJSON = "{\"revision\":6,\"unread\":{\"session-a\":6}}"
        await synced.refresh()
        readReply = "{\"state\":{\"revision\":7,\"unread\":{}}}"
        beforeReadReply = { [weak synced] in
            sharedJSON = "{\"revision\":8,\"unread\":{\"session-a\":8}}"
            await synced?.refresh()
        }
        await synced.markRead(synced.readTarget(for: "session-a")!)?.value
        beforeReadReply = nil
        check(synced.state.readToken(for: "session-a") == 8, "late POST response cannot regress a newer poll snapshot")
        sharedJSON = "null"
        await synced.refresh()
        check(!synced.connected && synced.state.unread == ["session-a"], "malformed running snapshot preserves unread instead of reverting to legacy mode")
        sharedJSON = "{\"revision\":8,\"unread\":{\"session-a\":8}}"
        await synced.refresh()

        for status in [401, 403, 500, 302] {
            readStatus = status
            let countBefore = readRequests.count
            await synced.markRead(synced.readTarget(for: "session-a")!)?.value
            check(readRequests.count == countBefore + 1 && synced.state.unread == ["session-a"], "HTTP \(status) retains unread and does not retry")
            check(synced.navigationError?.contains("同步失败") == true, "shared write failure is visible, not fake read success")
        }
        readStatus = 200
        readReply = "{\"state\":null}"
        await synced.markRead(synced.readTarget(for: "session-a")!)?.value
        check(synced.state.unread == ["session-a"], "malformed successful POST is not read confirmation")
        loseReadReply = true
        await synced.markRead(synced.readTarget(for: "session-a")!)?.value
        let uncertainCount = readRequests.count
        check(synced.state.unread == ["session-a"], "lost acknowledgement remains unread until reconciled")
        loseReadReply = false
        sharedJSON = "{\"revision\":9,\"unread\":{}}"
        await synced.refresh()
        check(synced.state.unread.isEmpty && readRequests.count == uncertainCount, "later GET reconciles a lost reply without replaying a write")
        let zeroRead = synced.readTarget(for: "session-b")!
        check(zeroRead.token == 0, "no observed unread produces a token-zero receipt")
        let wrongOrigin = SessionReadTarget(origin: "http://127.0.0.1:30142", sessionID: zeroRead.sessionID, token: 0, generation: zeroRead.generation)
        check(synced.markRead(wrongOrigin) == nil && synced.readTarget(for: "../bad") == nil, "read target is endpoint-bound with safe session ID")
        beforeSharedCookie = { [weak synced] in synced?.suspend() }
        await synced.markRead(zeroRead)?.value
        check(readRequests.count == uncertainCount, "sleep during read auth lookup prevents write")
        check(synced.markRead(zeroRead) == nil, "receipt captured before suspension cannot be used later")
        beforeSharedCookie = nil
        synced.stop()

        defaults.set(["session-a"], forKey: "unread")
        var legacyPosts = 0
        var legacySupportsShared = false
        let legacy = PiStore(endpoint: endpoint, defaults: defaults, cookieProvider: { [] }, responseTransport: { request in
            if request.httpMethod == "POST" { legacyPosts += 1 }
            let snapshot = legacySupportsShared
                ? "{\"sessionListVersion\":1,\"runningSessionIds\":[],\"awaitingInputSessionIds\":[],\"sessionReadState\":{\"revision\":10,\"unread\":{\"session-a\":10}}}"
                : "{\"sessionListVersion\":1,\"runningSessionIds\":[],\"awaitingInputSessionIds\":[]}"
            return reply(request, body: request.url?.path == "/api/sessions" ? sessionList : snapshot)
        })
        await legacy.refresh()
        let legacyRead = legacy.readTarget(for: "session-a")!
        check(legacyRead.token == nil && legacy.state.unread == ["session-a"], "absent protocol retains old-backend behavior")
        check(legacy.markRead(legacyRead) == nil && legacy.state.unread.isEmpty && legacyPosts == 0, "old backend clears locally with no unsupported POST")
        legacySupportsShared = true
        await legacy.refresh()
        check(legacy.markRead(legacyRead) == nil && legacy.state.unread == ["session-a"] && legacyPosts == 0, "legacy click captured before upgrade cannot clear shared unread")
        legacy.stop()

        print("PASS: \(checks) native transport, shared read-state, captured-target and at-most-one-attempt checks; no real server writes")
    }
}
