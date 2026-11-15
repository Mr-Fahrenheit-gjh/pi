import Foundation

@main struct LiveProbe {
    static func main() async throws {
        let endpoint = try PiEndpoint("http://127.0.0.1:30141")
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        let client = URLSession(configuration: config, delegate: LoopbackRedirectGuard(endpoint: endpoint), delegateQueue: nil)
        defer { client.invalidateAndCancel() }
        let (data, response) = try await client.data(from: endpoint.api("api/agent/running"))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        let snapshot = try JSONDecoder().decode(RunningSnapshot.self, from: data)
        let (listData, listResponse) = try await client.data(from: endpoint.api("api/sessions"))
        guard (listResponse as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        let list = try JSONDecoder().decode(SessionList.self, from: listData)
        var sharedCheck = "not supported by this Web"
        if let shared = snapshot.sessionReadState {
            let (readData, readResponse) = try await client.data(from: endpoint.api("api/sessions/read-state"))
            guard (readResponse as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            struct ReadReply: Decodable { let state: SharedReadState }
            let current = try JSONDecoder().decode(ReadReply.self, from: readData).state
            guard current.revision >= shared.revision,
                  current.revision != shared.revision || current == shared else { throw URLError(.cannotParseResponse) }
            var state = SessionState(unread: ["legacy-probe-marker"])
            state.apply(snapshot, sessions: list.sessions, visibleSession: nil)
            state.applyReadState(current, sessions: list.sessions)
            let eligible = Set(list.sessions.filter { !$0.isChild }.map(\.id))
            let expected = Set(current.unread.keys).intersection(eligible).subtracting(state.running)
            guard state.unread == expected else { throw URLError(.cannotParseResponse) }
            sharedCheck = "both endpoints/native state agree at revision \(current.revision)"
        }
        var checkedSSE = false
        // Only attach to a currently waiting live session; do not cold-start a historical agent.
        if let id = snapshot.awaitingInputSessionIds.first(where: { snapshot.runningSessionIds.contains($0) }) {
            let (bytes, streamResponse) = try await client.bytes(from: endpoint.agentURL(id, events: true))
            guard (streamResponse as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            for try await line in bytes.lines where line.hasPrefix("data:") {
                guard let eventData = String(line.dropFirst(5)).data(using: .utf8),
                      let event = try? JSONDecoder().decode(ApprovalEvent.self, from: eventData) else { continue }
                if event.type == "startup_error" { throw URLError(.cannotConnectToHost) }
                if event.type == "connected" {
                    guard event.sessionId == id, event.pendingExtensionUiIds != nil else { throw URLError(.cannotParseResponse) }
                    checkedSSE = true
                    break
                }
            }
            guard checkedSSE else { throw URLError(.zeroByteResource) }
        }
        print("PASS: live read-only API; \(list.sessions.count) sessions; shared unread: \(sharedCheck); SSE \(checkedSSE ? "snapshot verified" : "not exercised (no waiting session)"); no prompt, read-state write or approval submitted")
    }
}
