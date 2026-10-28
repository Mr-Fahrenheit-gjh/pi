import AppKit
import Carbon

/// Minimal interpreter for the typed object/condition descriptors used by the navigator.
/// Every simulated user race happens before resolving the mutation's direct object.
private final class FakeChrome {
    enum Race { case none, reorderBeforeMetadata, reorderBeforeSelection, navigateBeforeSelection, navigateBeforeURLWrite }
    var urls = ["other": "https://example.com/private", "pi": "http://127.0.0.1:30141/?sidebar=expanded&session=old",
                "exact": "http://127.0.0.1:30141/?session=target"]
    var order = ["other", "pi", "exact"]
    var activeIndex = 2
    var writes: [(String, String, NSAppleEventDescriptor)] = []
    var race = Race.none
    var rejectConditions = false
    var permissionDenied = false
    var eventCount = 0
    enum BridgeReply { case none, accepted, wrongNonce, wrongPage, wrongSession }
    var bridgeReply = BridgeReply.none
    private var metadataReordered = false
    private let window = ChromeTabNavigator.object("cwin", id: NSAppleEventDescriptor(string: "window"))
    private func field(_ object: NSAppleEventDescriptor, _ keyword: AEKeyword) -> NSAppleEventDescriptor {
        object.forKeyword(keyword)!
    }
    private func code(_ value: String) -> OSType { ChromeTabNavigator.fourCC(value) }

    func send(_ event: NSAppleEventDescriptor) throws -> NSAppleEventDescriptor {
        eventCount += 1
        precondition(event.eventClass == 0x636f7265, "Chrome getd/setd belong to core, not the aevt application-event class")
        precondition(event.eventID == kAEGetData || event.eventID == kAESetData, "Never create tabs, execute JS, or send desktop input")
        let object = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))!
        let result: NSAppleEventDescriptor
        if permissionDenied { throw ChromeNavigationError.permissionDenied }
        if event.eventID == kAESetData {
            let property = field(object, AEKeyword(keyAEKeyData)).typeCodeValue
            if property == code("acTI") && race == .reorderBeforeSelection {
                let active = order[activeIndex - 1]
                order.swapAt(0, 1)
                activeIndex = order.firstIndex(of: active)! + 1
            }
            if (property == code("acTI") && race == .navigateBeforeSelection) ||
                (property == code("URL ") && race == .navigateBeforeURLWrite) {
                urls["pi"] = "https://example.com/changed"
            }
            let targets = try resolve(field(object, AEKeyword(keyAEContainer)))
            guard !targets.isEmpty else { throw ChromeNavigationError.tabChanged }
            let value = event.paramDescriptor(forKeyword: AEKeyword(keyAEData))!
            let bytes = (0..<4).map { UInt8((property >> ((3 - $0) * 8)) & 255) }
            let name = String(bytes: bytes, encoding: .ascii)!
            for target in targets {
                writes.append((name, target, value))
                switch name {
                case "acTI": activeIndex = Int(value.int32Value)
                case "URL ":
                    urls[target] = value.stringValue
                    if bridgeReply != .none, let written = value.stringValue.flatMap(URL.init(string:)),
                       case let .request(page, nonce, session) = PiMenuFragment.parse(written) {
                        var parts = URLComponents(url: written, resolvingAgainstBaseURL: false)!
                        parts.queryItems = (parts.queryItems ?? []).filter { $0.name != "session" && $0.name != "cwd" } + [
                            URLQueryItem(name: "session", value: bridgeReply == .wrongSession ? "wrong" : session)
                        ]
                        parts.fragment = "pi-menu=1&page=\(bridgeReply == .wrongPage ? UUID().uuidString : page)&ack=\(bridgeReply == .wrongNonce ? UUID().uuidString : nonce)"
                        urls[target] = parts.url!.absoluteString
                    }
                case "pidx", "pmnd": break
                default: preconditionFailure("Unexpected browser mutation: \(name)")
                }
            }
            result = .null()
        } else if field(object, AEKeyword(keyAEDesiredClass)).typeCodeValue == code("prop") {
            let container = field(object, AEKeyword(keyAEContainer))
            if race == .reorderBeforeMetadata && !metadataReordered,
               field(object, AEKeyword(keyAEKeyData)).typeCodeValue == code("ID  "),
               container.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == code("CrTb"),
               container.forKeyword(AEKeyword(keyAEKeyForm))?.enumCodeValue == code("indx") {
                let active = order[activeIndex - 1]
                order.swapAt(0, 1)
                activeIndex = order.firstIndex(of: active)! + 1
                metadataReordered = true
            }
            result = try value(object)
        } else {
            result = list(try resolve(object).map(reference))
        }
        let reply = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEAnswer),
                                           targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: 0)
        reply.setParam(result, forKeyword: AEKeyword(keyDirectObject))
        return reply
    }

    private func resolve(_ object: NSAppleEventDescriptor, examined: String? = nil) throws -> [String] {
        if object.descriptorType == typeObjectBeingExamined { return examined.map { [$0] } ?? [] }
        let wanted = field(object, AEKeyword(keyAEDesiredClass)).typeCodeValue
        let data = field(object, AEKeyword(keyAEKeyData))
        let container = field(object, AEKeyword(keyAEContainer))
        if wanted == code("prop") {
            precondition(data.typeCodeValue == code("acTa"))
            return try resolve(container, examined: examined).map { _ in order[activeIndex - 1] }
        }
        let candidates: [String]
        if wanted == code("cwin") { candidates = ["window"] }
        else {
            precondition(wanted == code("CrTb"))
            candidates = try resolve(container, examined: examined).contains("window") ? order : []
        }
        switch field(object, AEKeyword(keyAEKeyForm)).enumCodeValue {
        case code("ID  "): return candidates.filter { $0 == data.stringValue }
        case code("indx"):
            if data.descriptorType == typeAbsoluteOrdinal {
                precondition(data.enumCodeValue == code("all "))
                return candidates
            }
            let index = Int(data.int32Value) - 1
            return candidates.indices.contains(index) ? [candidates[index]] : []
        case code("test"):
            if rejectConditions { throw ChromeNavigationError.browserUnavailable }
            return try candidates.filter { try matches(data, examined: $0) }
        default: preconditionFailure("Unexpected reference form")
        }
    }
    private func matches(_ test: NSAppleEventDescriptor, examined: String) throws -> Bool {
        if test.descriptorType == typeLogicalDescriptor {
            precondition(field(test, AEKeyword(keyAELogicalOperator)).enumCodeValue == kAEAND)
            return try ChromeTabNavigator.items(field(test, AEKeyword(keyAELogicalTerms))).allSatisfy { try matches($0, examined: examined) }
        }
        precondition(test.descriptorType == typeCompDescriptor)
        precondition(field(test, AEKeyword(keyAECompOperator)).enumCodeValue == kAEEquals)
        let lhs = try value(field(test, AEKeyword(keyAEObject1)), examined: examined)
        let rhs = try value(field(test, AEKeyword(keyAEObject2)), examined: examined)
        return lhs.stringValue == rhs.stringValue
    }
    private func value(_ descriptor: NSAppleEventDescriptor, examined: String? = nil) throws -> NSAppleEventDescriptor {
        guard descriptor.descriptorType == typeObjectSpecifier else { return descriptor }
        let property = field(descriptor, AEKeyword(keyAEKeyData)).typeCodeValue
        let container = field(descriptor, AEKeyword(keyAEContainer))
        let objects = try resolve(container, examined: examined)
        let values: [NSAppleEventDescriptor] = objects.map { object in
            switch property {
            case code("ID  "): return NSAppleEventDescriptor(string: object)
            case code("acTI"): return NSAppleEventDescriptor(int32: Int32(activeIndex))
            case code("acTa"): return reference(order[activeIndex - 1])
            case code("URL "): return NSAppleEventDescriptor(string: urls[object]!)
            default: preconditionFailure("Unexpected metadata query")
            }
        }
        let collection = container.forKeyword(AEKeyword(keyAEKeyData))?.descriptorType == typeAbsoluteOrdinal
        return collection || values.count != 1 ? list(values) : values[0]
    }
    private func reference(_ id: String) -> NSAppleEventDescriptor {
        id == "window" ? window : ChromeTabNavigator.object("CrTb", id: NSAppleEventDescriptor(string: id), of: window)
    }
    private func list(_ values: [NSAppleEventDescriptor]) -> NSAppleEventDescriptor {
        let list = NSAppleEventDescriptor.list()
        for (index, value) in values.enumerated() { list.insert(value, at: index + 1) }
        return list
    }
}

@main struct BrowserTests {
    static func main() throws {
        var checks = 0
        func check(_ value: Bool, _ label: String) { precondition(value, label); checks += 1 }
        let endpoint = try PiEndpoint("http://127.0.0.1:30141")
        let navigator = ChromeTabNavigator(endpoint: endpoint)
        check(ChromeTabNavigator.sendOptions.rawValue & 0x00020000 != 0, "Send layer forbids system consent prompts, including preflight/send races")
        let target = NSAppleEventDescriptor(processIdentifier: 1) // Injected transport; never sent to a real browser.
        let exact = FakeChrome()
        try navigator.navigate(sessionID: "target", target: target, send: exact.send)
        check(exact.activeIndex == 3, "Focus already-open exact session")
        check(exact.writes.map { $0.0 } == ["acTI", "pmnd", "pidx"], "Exact session is not reloaded")
        check(exact.urls.count == 3, "No new tab created")
        let crowded = FakeChrome()
        let extras = (0..<100).map { "extra-\($0)" }
        for id in extras { crowded.urls[id] = "https://example.com/\(id)" }
        crowded.order = ["other"] + extras + ["pi", "exact"]
        crowded.activeIndex = crowded.order.count - 1
        try navigator.navigate(sessionID: "target", target: target, send: crowded.send)
        check(crowded.activeIndex == crowded.order.count, "Find the exact Pi session even at the end of a crowded window")
        check(crowded.eventCount == exact.eventCount && crowded.eventCount <= 16, "Batch queries have constant round trips instead of one per tab")

        let switched = FakeChrome()
        try navigator.navigate(sessionID: "new & session", target: target, send: switched.send)
        check(switched.activeIndex == 2, "Prefer the active existing Pi tab")
        check(switched.writes.map { $0.0 } == ["acTI", "pmnd", "pidx", "URL "], "Bring the Pi window forward before navigating; never wait for a reload to show Chrome")
        let updated = URL(string: switched.urls["pi"]!)!
        check(PiBrowserPolicy.session(in: updated) == "new & session", "Session ID encoded and preserved exactly")
        check(URLComponents(url: updated, resolvingAgainstBaseURL: false)?.queryItems?.contains(URLQueryItem(name: "sidebar", value: "expanded")) == true,
              "Preserve the existing browser layout")
        check(switched.urls["other"] == "https://example.com/private" && switched.urls["exact"] == "http://127.0.0.1:30141/?session=target", "Other tabs untouched")
        check(switched.writes.filter { $0.0 == "URL " }.allSatisfy { $0.1 == "pi" }, "Navigate only the pinned Pi tab ID")

        do {
            try navigator.navigate(sessionID: nil, target: target, send: { _ in
                let reply = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEAnswer),
                                                   targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: 0)
                reply.setParam(NSAppleEventDescriptor(int32: -1708), forKeyword: AEKeyword(keyErrorNumber))
                return reply
            })
            preconditionFailure("Expected unsupported Apple-event failure")
        } catch ChromeNavigationError.commandFailed(let operation, let code) {
            check(code == -1708 && operation == "读取窗口列表", "Report the native event error instead of pretending the user changed tabs")
        }
        do {
            try navigator.navigate(sessionID: nil, target: target, send: { _ in
                let reply = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEAnswer),
                                                   targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: 0)
                reply.setParam(NSAppleEventDescriptor(int32: -1744), forKeyword: AEKeyword(keyErrorNumber))
                return reply
            }, verifyOnly: true)
            preconditionFailure("Expected missing consent")
        } catch ChromeNavigationError.diagnosticNotAuthorized {
            check(true, "Diagnostic consent-required reply explains that no permission was requested")
        }
        let probe = FakeChrome()
        try navigator.navigate(sessionID: nil, target: target, send: probe.send, verifyOnly: true)
        check(probe.writes.isEmpty, "Native diagnostic mode only queries, never selects or navigates")
        let focusOnly = FakeChrome()
        try navigator.navigate(sessionID: nil, target: target, send: focusOnly.send)
        check(!focusOnly.writes.contains { $0.0 == "URL " }, "Root action focuses Pi without resetting current conversation")
        let warm = FakeChrome()
        let locations = try navigator.navigate(sessionID: nil, target: target, send: warm.send, prewarmOnly: true)
        check(warm.writes.isEmpty && locations.count == 2, "Prewarm is read-only and retains only Pi metadata")
        warm.eventCount = 0
        try navigator.navigate(sessionID: "target", target: target, send: warm.send, cached: locations)
        check(warm.eventCount == 5, "Hot focus uses one cached guard and four guarded focus operations")
        let cache = PiChromeCache(pid: 12, created: 100, locations: locations)
        check(cache.valid(for: 12, now: 101) != nil && cache.valid(for: 13, now: 101) == nil && cache.valid(for: 12, now: 109) == nil,
              "Chrome restart and expiry invalidate short-lived memory cache")
        let stale = FakeChrome()
        stale.order.swapAt(0, 1)
        stale.activeIndex = 1
        try navigator.navigate(sessionID: "new", target: target, send: stale.send, cached: locations)
        check(stale.activeIndex == 1 && stale.writes.first?.1 == "window", "Reordered cache is rescanned before any write")
        let closed = FakeChrome()
        closed.order = ["other"]
        closed.activeIndex = 1
        do { try navigator.navigate(sessionID: "new", target: target, send: closed.send, cached: locations); preconditionFailure("Expected closed cached tab failure") }
        catch { check(closed.writes.isEmpty, "Closed cache cannot focus or overwrite a different tab") }

        let page = "00000000-0000-4000-8000-000000000001"
        let readyURL = "http://127.0.0.1:30141/?sidebar=expanded&cwd=old-dir&session=old#pi-menu=1&page=\(page)"
        let bridge = FakeChrome()
        bridge.urls["pi"] = readyURL
        bridge.bridgeReply = .accepted
        var activated = false
        let accepted = try navigator.navigate(sessionID: "new-session", target: target, send: bridge.send, activate: {
            check(bridge.writes.map { $0.0 } == ["acTI", "pmnd", "pidx"], "Chrome activates before sending the bridge request")
            activated = true
        })
        check(activated && PiBrowserPolicy.session(in: accepted[0].url) == "new-session", "Only acknowledged selection succeeds")
        let requested = URL(string: bridge.writes.first { $0.0 == "URL " }!.2.stringValue!)!
        check(URLComponents(url: requested, resolvingAgainstBaseURL: false)?.percentEncodedQuery == URLComponents(string: readyURL)?.percentEncodedQuery,
              "Bridge writes only a fragment, preserving the original query until ack")
        if case .ack(let ackPage, _) = PiMenuFragment.parse(accepted[0].url) { check(ackPage == page, "Ack proves the same document identity") }
        else { preconditionFailure("Missing ack") }
        let noReload = FakeChrome()
        noReload.urls["pi"] = "http://127.0.0.1:30141/?session=old#pi-menu=1&page=\(page)"
        try navigator.navigate(sessionID: "old", target: target, send: noReload.send)
        check(noReload.writes.allSatisfy { $0.0 != "URL " }, "Same bridge session is only focused; no URL mutation or remount")
        for mode in [FakeChrome.BridgeReply.none, .wrongNonce, .wrongPage, .wrongSession] {
            let unconfirmed = FakeChrome()
            unconfirmed.urls["pi"] = readyURL
            unconfirmed.bridgeReply = mode
            do { try navigator.navigate(sessionID: "new", target: target, send: unconfirmed.send, acknowledgementTimeout: 0); preconditionFailure("Expected invalid/missing ack failure") }
            catch { check(unconfirmed.writes.filter { $0.0 == "URL " }.count == 1, "No ack means failure, never resend or fall back to reload") }
        }
        for fragment in ["pi-menu=2&page=\(page)", "pi-menu=1&page=\(page)&page=\(page)", "pi-menu=1&page=bad",
                         "pi-menu=1&page=\(page)&extra=1", "pi-menu=1&page=\(page)&request=\(page)&session=new"] {
            let invalid = FakeChrome()
            invalid.urls["pi"] = "http://127.0.0.1:30141/?session=old#\(fragment)"
            do { try navigator.navigate(sessionID: "new", target: target, send: invalid.send); preconditionFailure("Expected bridge fail-closed") }
            catch { check(invalid.writes.isEmpty, "Invalid or pending protocol never becomes legacy reload") }
        }
        let oldWithCwd = FakeChrome()
        oldWithCwd.urls["pi"] = "http://127.0.0.1:30141/?cwd=somewhere&session=new&sidebar=expanded"
        try navigator.navigate(sessionID: "new", target: target, send: oldWithCwd.send)
        check(!(URLComponents(string: oldWithCwd.urls["pi"]!)!.queryItems ?? []).contains { $0.name == "cwd" },
              "Legacy navigation removes cwd even when the query already names the target session")
        let metadataRace = FakeChrome()
        metadataRace.race = .reorderBeforeMetadata
        do { try navigator.navigate(sessionID: "new", target: target, send: metadataRace.send); preconditionFailure("Expected mismatched metadata failure") }
        catch { check(metadataRace.writes.isEmpty, "A reorder between URL/ID batches cannot select or change the mismatched tab") }
        let reordered = FakeChrome()
        reordered.activeIndex = 1
        reordered.race = .reorderBeforeSelection
        do { try navigator.navigate(sessionID: "new", target: target, send: reordered.send); preconditionFailure("Expected changed-tab failure") }
        catch {
            check(reordered.writes.isEmpty, "Index reordering at set-time cannot activate an unrelated tab")
            check(reordered.order[reordered.activeIndex - 1] == "other", "The prior active tab is unchanged")
        }
        let changed = FakeChrome()
        changed.race = .navigateBeforeSelection
        do { try navigator.navigate(sessionID: "new", target: target, send: changed.send); preconditionFailure("Expected origin check failure") }
        catch { check(changed.writes.isEmpty, "A changed origin prevents even the tab selection") }
        let lateChange = FakeChrome()
        lateChange.race = .navigateBeforeURLWrite
        do { try navigator.navigate(sessionID: "new", target: target, send: lateChange.send); preconditionFailure("Expected late origin failure") }
        catch {
            check(!lateChange.writes.contains { $0.0 == "URL " }, "URL change between getter and setter rejects the write")
            check(lateChange.urls["pi"] == "https://example.com/changed", "Never overwrite the newly navigated external page")
        }
        let unsupported = FakeChrome()
        unsupported.rejectConditions = true
        do { try navigator.navigate(sessionID: "new", target: target, send: unsupported.send); preconditionFailure("Expected unsupported condition failure") }
        catch { check(unsupported.writes.isEmpty, "Unsupported conditions never fall back to an unconditional write") }
        let denied = FakeChrome()
        denied.permissionDenied = true
        do { try navigator.navigate(sessionID: "new", target: target, send: denied.send); preconditionFailure("Expected permission failure") }
        catch { check(denied.writes.isEmpty, "Permission refusal performs no browser mutation") }
        let absent = FakeChrome()
        absent.order = ["other"]
        absent.activeIndex = 1
        do { try navigator.navigate(sessionID: "new", target: target, send: absent.send); preconditionFailure("Expected missing-tab failure") }
        catch { check(absent.writes.isEmpty, "No matching tab fails closed, never opens a new one") }
        for url in ["http://127.0.0.1:30142/", "https://127.0.0.1:30141/", "http://127.0.0.1:30141/api/sessions", "http://user@127.0.0.1:30141/"] {
            check(!PiBrowserPolicy.isPiPage(URL(string: url)!, endpoint: endpoint), "Origin/root-path scope is enforced")
        }
        print("PASS: \(checks) existing Chrome tab routing and conditional Apple-event checks; no real browser operations")
    }
}
