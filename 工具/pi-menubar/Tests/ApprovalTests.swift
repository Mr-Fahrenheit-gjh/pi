import Foundation

@main struct ApprovalTests {
    static func main() throws {
        var checks = 0
        func check(_ value: Bool, _ name: String) { precondition(value, name); checks += 1 }
        func event(_ values: [String: Any]) throws -> ApprovalEvent {
            try JSONDecoder().decode(ApprovalEvent.self, from: JSONSerialization.data(withJSONObject: values))
        }
        let endpoint = try PiEndpoint("http://127.0.0.1:30141")
        let origin = endpoint.base.absoluteString
        let now = Date(timeIntervalSince1970: 1_000)
        func target(_ id: String, _ session: String = "a") -> ApprovalTarget {
            ApprovalTarget(origin: origin, sessionID: session, requestID: id)
        }
        func connected(_ ids: [String], _ session: String = "a") throws -> ApprovalEvent {
            try event(["type": "connected", "sessionId": session, "pendingExtensionUiIds": ids])
        }
        func question(_ id: String, _ method: String = "select", extra: [String: Any] = [:]) throws -> ApprovalEvent {
            try event(["type": "extension_ui_request", "id": id, "method": method, "title": "完整问题\n下一行",
                       "message": "完整确认内容", "options": [" A · 保留空格 ", "B"]].merging(extra) { _, new in new })
        }
        func payload(_ method: String, _ answer: ApprovalAnswer) throws -> [String: Any] {
            let request = ApprovalRequest(try question("q", method))
            let response = request.response(id: "q", answer: answer)!
            return try JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as! [String: Any]
        }
        let selected = try payload("select", .value(" A · 保留空格 "))
        check(selected["value"] as? String == " A · 保留空格 " && selected.count == 3, "select sends original option, never an index")
        check(selected["type"] as? String == "extension_ui_response" && selected["id"] as? String == "q", "exact response envelope")
        check(ApprovalRequest(try question("q")).response(id: "q", answer: .value("A")) == nil, "no guessed or trimmed option")
        check(ApprovalRequest(try question("q")).response(id: "q", answer: .confirm(true)) == nil, "reject wrong response kind")
        check(try payload("input", .value(""))["value"] as? String == "", "empty input preserved")
        check(try payload("editor", .value("line 1\n line 2\n"))["value"] as? String == "line 1\n line 2\n", "editor whitespace preserved")
        for answer in [true, false] {
            let body = try payload("confirm", .confirm(answer))
            check(body["confirmed"] as? Bool == answer && body.count == 3, "confirm uses only confirmed")
        }
        let cancel = try payload("input", .cancel)
        check(cancel["cancelled"] as? Bool == true && cancel.count == 3, "cancel uses only cancelled")

        var state = ApprovalState()
        let first = state.beginConnection("a")
        state.receive(try question("q"), origin: origin, sessionID: "a", generation: first, now: now)
        check(state.pending.isEmpty, "HTTP/SSE comments without connected do not enable forms")
        state.receive(try connected(["q"]), origin: origin, sessionID: "a", generation: first, now: now)
        state.receive(try question("q"), origin: origin, sessionID: "a", generation: first, now: now)
        state.receive(try question("q"), origin: origin, sessionID: "a", generation: first, now: now)
        check(state.pending.count == 1 && state.pending[target("q")]?.canRespond(at: now) == true, "replay is deduplicated and ready")
        check(state.shouldNotify(target("q"), generation: first, now: now), "open current question can notify")
        check(state.beginSubmission(target("q"), answer: .value("bogus"), now: now) == nil, "invalid answer not submitted")
        let sent = state.beginSubmission(target("q"), answer: .value("B"), now: now)!
        check(sent.target == target("q") && state.maySend(sent, at: now), "submission captures endpoint/session/request")
        check(!state.shouldNotify(target("q"), generation: first, now: now), "permission/delivery delay cannot notify after local submission")
        check(state.beginSubmission(target("q"), answer: .cancel, now: now) == nil, "confirm and cancel share synchronous lock")
        state.finish(sent, receivedHTTPReply: false)
        check(state.pending[target("q")]?.phase == .uncertain, "lost reply remains uncertain")
        check(state.beginSubmission(target("q"), answer: .value("B"), now: now) == nil, "no retry after lost reply")
        state.receive(try question("q"), origin: origin, sessionID: "a", generation: first, now: now)
        check(state.pending[target("q")]?.phase == .uncertain, "replay cannot unlock uncertain attempt")
        state.receive(try event(["type": "extension_ui_closed", "id": "q"]), origin: origin, sessionID: "a", generation: first)
        check(state.pending.isEmpty, "closure removes form without claiming success")
        check(!state.shouldNotify(target("q"), generation: first, now: now), "close during delivery invalidates notification")
        state.receive(try question("q"), origin: origin, sessionID: "a", generation: first, now: now)
        check(state.beginSubmission(target("q"), answer: .cancel, now: now) == nil, "closed attempted ID cannot be resent")

        state.receive(try question("next", "input"), origin: origin, sessionID: "a", generation: first, now: now)
        check(state.pending[target("next")]?.canRespond(at: now) == true, "next question independently available")
        state.disconnect("a", generation: first)
        check(state.pending[target("next")]?.phase == .syncing, "disconnect immediately disables old form")
        check(state.beginSubmission(target("next"), answer: .value("text"), now: now) == nil, "cannot answer offline")
        let second = state.beginConnection("a")
        state.receive(try connected(["next"]), origin: origin, sessionID: "a", generation: second, now: now)
        check(state.pending[target("q")] == nil, "snapshot prunes missed closed requests")
        check(state.pending[target("next")]?.phase == .syncing, "snapshot alone cannot restore old details")
        state.receive(try event(["type": "extension_ui_closed", "id": "next"]), origin: origin, sessionID: "a", generation: first)
        check(state.pending[target("next")] != nil, "old generation close ignored")
        state.receive(try question("next", "input"), origin: origin, sessionID: "a", generation: second, now: now)
        check(state.pending[target("next")]?.canRespond(at: now) == true, "new-generation replay restores ready form")
        check(!state.shouldNotify(target("next"), generation: first, now: now), "old notification task cannot outlive its connection")
        state.disconnect("a", generation: first)
        check(state.isConnected("a"), "late old disconnection cannot disable new connection")
        let queued = state.beginSubmission(target("next"), answer: .value(""), now: now)!
        state.receive(try event(["type": "extension_ui_closed", "id": "next"]), origin: origin, sessionID: "a", generation: second)
        check(!state.maySend(queued, at: now), "closure during cookie lookup prevents send")
        state.finish(queued, receivedHTTPReply: true)
        check(state.pending[target("next")] == nil, "late HTTP 200 does not resurrect closed form")

        state.receive(try question("timed", extra: ["expiresAt": 1_000_100.0]), origin: origin, sessionID: "a", generation: second, now: now)
        check(state.pending[target("timed")]?.canRespond(at: now) == true, "expiry uses milliseconds")
        let later = now.addingTimeInterval(0.1)
        check(!state.shouldNotify(target("timed"), generation: second, now: later), "expiry is rechecked even before expiry poll")
        check(state.beginSubmission(target("timed"), answer: .value("B"), now: later) == nil, "expiry checked again on click")
        check(state.pending[target("timed")]?.phase == .expired, "expired form stays disabled")
        state.receive(try question("custom", "custom"), origin: origin, sessionID: "a", generation: second, now: now)
        check(state.pending[target("custom")]?.request.supportsNative == false, "custom is a browser fallback, never terminal parsing")
        check(state.shouldNotify(target("custom"), generation: second, now: now), "custom still receives attention notifications")
        check(state.beginSubmission(target("custom"), answer: .cancel, now: now) == nil, "custom cannot use standard response even to cancel")
        state.receive(try question("custom", "custom", extra: ["closed": true]), origin: origin, sessionID: "a", generation: second, now: now)
        check(state.pending[target("custom")] == nil, "custom closed lifecycle")
        let malformed = try event(["type": "extension_ui_request", "id": "bad", "method": "select", "title": "缺少选项"])
        check(!ApprovalRequest(malformed).supportsNative, "malformed standard request cannot be answered")
        check((try? event(["type": "extension_ui_request", "id": "bad", "method": "select", "options": [42]])) == nil, "wrong field types fail closed")

        let b = state.beginConnection("b")
        state.receive(try connected(["timed"], "b"), origin: origin, sessionID: "b", generation: b, now: now)
        state.receive(try question("timed"), origin: origin, sessionID: "b", generation: b, now: now)
        check(state.pending[target("timed", "b")]?.canRespond(at: now) == true, "same UI ID in another session is isolated")
        let bSent = state.beginSubmission(target("timed", "b"), answer: .value("B"), now: now)!
        state.finish(bSent, receivedHTTPReply: true)
        check(state.pending[target("timed", "b")]?.phase == .sent, "HTTP 200 only records reply, not an accepted verdict")
        state.disconnectAll()
        check(!state.isConnected("a") && !state.isConnected("b"), "sleep disables all SSE readiness")
        state.retainSessions([])
        check(state.pending.isEmpty, "no stale forms after sessions stop awaiting")

        let guardDelegate = LoopbackRedirectGuard(endpoint: endpoint)
        check(!guardDelegate.allows(method: "POST", destination: endpoint.api("login")), "POST refuses even same-origin redirects")
        check(guardDelegate.allows(method: "GET", destination: endpoint.api("api/sessions")), "GET may stay on pinned origin")
        for url in ["http://127.0.0.1:30142/api", "http://localhost:30141/api", "https://127.0.0.1:30141/api", "http://user@127.0.0.1:30141/api"] {
            check(!guardDelegate.allows(method: "GET", destination: URL(string: url)), "redirect cannot change origin/credentials")
        }
        for id in ["../other", "..", "a/b", "a?x=1", "a#fragment", ""] {
            check((try? endpoint.agentURL(id)) == nil, "session cannot change response route")
        }
        func cookie(_ name: String = "pi_web_session", domain: String = "127.0.0.1", path: String = "/", secure: Bool = false, expires: Date? = nil) -> HTTPCookie {
            var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: "test-only", .domain: domain, .path: path]
            if secure { properties[.secure] = "TRUE" }
            if let expires { properties[.expires] = expires }
            return HTTPCookie(properties: properties)!
        }
        let cookies = [cookie(), cookie("unrelated"), cookie(domain: "localhost"), cookie(path: "/api/agents"),
                       cookie(secure: true), cookie(expires: now.addingTimeInterval(-1))]
        check(PiCookies.applicable(cookies, to: try endpoint.agentURL("a"), now: now).count == 1, "only applicable unexpired auth cookie")
        check(PiCookies.applicable([cookie(path: "/api")], to: try endpoint.agentURL("a"), now: now).count == 1, "cookie path segment match")
        print("PASS: \(checks) native approval lifecycle, payload, cookie and redirect checks")
    }
}
