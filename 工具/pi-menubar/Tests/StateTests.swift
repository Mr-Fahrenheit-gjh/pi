import Foundation

@main struct StateTests {
    static func main() throws {
        var checks = 0
        func check(_ value: Bool, _ name: String) {
            precondition(value, name)
            checks += 1
        }
        let decoder = JSONDecoder()
        let sessions = try decoder.decode(SessionList.self, from: Data("""
        {"sessions":[
          {"id":"a","cwd":"/work/project","name":"对话 A","modified":"2026-10-26","firstMessage":"你好"},
          {"id":"b","cwd":"/work/project","modified":"2026-10-26","firstMessage":"首句\\n下一行"},
          {"id":"child","cwd":"/work/project","modified":"2026-10-26","relation":{"kind":"subagent"}}
        ],"sessionListVersion":1}
        """.utf8)).sessions
        func snapshot(_ running: [String], _ awaiting: [String] = [], suppressed: [String] = []) -> RunningSnapshot {
            RunningSnapshot(sessionListVersion: 1, runningSessionIds: running, awaitingInputSessionIds: awaiting,
                            completionNotificationSuppressedSessionIds: suppressed)
        }
        var state = SessionState(unread: ["gone", "b"])
        state.apply(snapshot(["a", "child"], ["a", "gone"]), sessions: sessions, visibleSession: nil)
        check(state.unread == ["b"], "first snapshot does not mark all history unread; prunes deleted")
        check(state.awaiting == ["a"], "awaiting is a running known session")
        check(state.recentHistory(in: sessions, limit: 4).map(\.id) == ["b"], "history excludes running, awaiting and child sessions")
        check(state.recentHistory(in: sessions, limit: 0).isEmpty, "busy active list needs no history filler")
        state.apply(snapshot([]), sessions: sessions, visibleSession: nil)
        check(state.unread == ["a", "b"], "completed parent unread, child excluded")
        state.markRead("a")
        check(state.unread == ["b"], "mark read")
        state.apply(snapshot(["a", "b"]), sessions: sessions, visibleSession: nil)
        check(state.unread.isEmpty, "new run clears unread")
        state.apply(snapshot([], suppressed: ["b"]), sessions: sessions, visibleSession: "a")
        check(state.unread.isEmpty, "visible completion and suppression")
        state.apply(snapshot(["a"]), sessions: sessions, visibleSession: "a")
        state.apply(snapshot([]), sessions: sessions, visibleSession: nil)
        check(state.unread == ["a"], "hidden popover does not mark selected session read")
        func sharedSnapshot(_ revision: Int, _ unread: [String: Int], running: [String] = []) throws -> RunningSnapshot {
            let data = try JSONSerialization.data(withJSONObject: [
                "sessionListVersion": 1, "runningSessionIds": running, "awaitingInputSessionIds": [],
                "sessionReadState": ["revision": revision, "unread": unread]
            ])
            return try decoder.decode(RunningSnapshot.self, from: data)
        }
        var shared = SessionState(unread: ["b"])
        shared.apply(try sharedSnapshot(1, ["a": 1]), sessions: sessions, visibleSession: nil)
        check(shared.unread == ["a"], "shared snapshot replaces stale native-only unread markers")
        shared.apply(try sharedSnapshot(2, [:]), sessions: sessions, visibleSession: nil)
        check(shared.unread.isEmpty, "reading in Web clears native unread on the next poll")
        shared.apply(try sharedSnapshot(3, ["b": 3]), sessions: sessions, visibleSession: nil)
        shared.apply(try sharedSnapshot(1, ["a": 1]), sessions: sessions, visibleSession: nil)
        check(shared.unread == ["b"], "older read-state response cannot replace a newer completion")
        shared.apply(try sharedSnapshot(4, [:], running: ["a"]), sessions: sessions, visibleSession: nil)
        shared.apply(try sharedSnapshot(4, [:]), sessions: sessions, visibleSession: nil)
        check(shared.unread.isEmpty, "shared mode never invents unread from local running transitions")
        shared.apply(try sharedSnapshot(5, ["a": 5, "child": 5, "gone": 5]), sessions: sessions, visibleSession: "a")
        check(shared.unread == ["a"], "shared unread is server-owned; popover visibility cannot clear it")
        shared.apply(snapshot([]), sessions: sessions, visibleSession: nil)
        check(shared.unread == ["a"], "missing shared field after activation preserves the last shared state")
        check(shared.readToken(for: "a") == 5 && shared.readToken(for: "b") == 0, "read targets bind to the observed completion token")
        shared.markRead("a")
        check(shared.unread == ["a"], "local legacy markRead cannot bypass shared confirmation")
        for invalid in [
            "null", "{}", "{\"revision\":-1,\"unread\":{}}", "{\"revision\":1.5,\"unread\":{}}",
            "{\"revision\":9007199254740992,\"unread\":{}}", "{\"revision\":2,\"unread\":{\"a\":0}}",
            "{\"revision\":2,\"unread\":{\"a\":3}}", "{\"revision\":2,\"unread\":{\"../a\":1}}"
        ] {
            let json = "{\"runningSessionIds\":[],\"awaitingInputSessionIds\":[],\"sessionReadState\":\(invalid)}"
            check((try? decoder.decode(RunningSnapshot.self, from: Data(json.utf8))) == nil, "invalid shared state is not old-backend compatibility")
        }
        check(!SharedReadState.validID("a\n") && !SharedReadState.validID(String(repeating: "a", count: 201)), "read-state IDs must be bounded exact matches")
        check(sessions[0].title == "对话 A" && sessions[1].title == "首句", "title fallbacks")
        check(sessions[0].project == "project", "project label")
        let dated = [PiSession(id: "old", cwd: "/p", name: "Old", firstMessage: nil, modified: "2026-01-01", relation: nil),
                     PiSession(id: "new", cwd: "/p", name: "New", firstMessage: nil, modified: "2026-10-26", relation: nil)]
        check(state.recentHistory(in: dated, limit: 1).map(\.id) == ["new"], "recent history is newest-first and bounded")
        let endpoint = try PiEndpoint("http://127.0.0.1:30141")
        check(endpoint.conversation("a &b").query?.contains("session=a%20%26b") == true, "encoded deep link")
        check(endpoint.contains(URL(string: "http://127.0.0.1:30141/api/agent/running")!), "same origin")
        check(!endpoint.contains(URL(string: "http://127.0.0.1:30142/")!), "reject alternate port")
        for invalid in ["https://example.com", "http://example.com", "file:///tmp/a", "http://user@localhost", "http://localhost/path", "http://localhost?x=y"] {
            check((try? PiEndpoint(invalid)) == nil, "reject non-local origin: \(invalid)")
        }
        for method in ["confirm", "select", "input", "editor", "custom"] {
            let event = try decoder.decode(ApprovalEvent.self, from: Data("{\"type\":\"extension_ui_request\",\"id\":\"q\",\"method\":\"\(method)\"}".utf8))
            check(event.isOpenQuestion, "blocking \(method)")
        }
        for json in [
            "{\"type\":\"extension_ui_request\",\"id\":\"q\",\"method\":\"notify\"}",
            "{\"type\":\"extension_ui_request\",\"id\":\"q\",\"method\":\"custom\",\"closed\":true}",
            "{\"type\":\"extension_ui_request\",\"id\":\"q\",\"method\":\"input\",\"expiresAt\":1}",
            "{\"type\":\"extension_ui_closed\",\"id\":\"q\"}"
        ] {
            check(!(try decoder.decode(ApprovalEvent.self, from: Data(json.utf8))).isOpenQuestion, "non-blocking/closed/expired ignored")
        }
        print("PASS: \(checks) state, event and endpoint checks")
    }
}
