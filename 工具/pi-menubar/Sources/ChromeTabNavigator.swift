import AppKit
import Carbon

struct PiBrowserTab: Equatable {
    let id: String
    let url: URL
    let active: Bool
}

enum PiBrowserPolicy {
    static func isPiPage(_ url: URL, endpoint: PiEndpoint) -> Bool {
        endpoint.contains(url) && (url.path.isEmpty || url.path == "/")
    }

    static func choose(_ tabs: [PiBrowserTab], endpoint: PiEndpoint, sessionID: String?) -> PiBrowserTab? {
        let candidates = tabs.filter { isPiPage($0.url, endpoint: endpoint) }
        if let sessionID {
            let exact = candidates.filter { session(in: $0.url) == sessionID }
            if let tab = exact.first(where: \.active) ?? exact.first { return tab }
        }
        return candidates.first(where: \.active) ?? candidates.first
    }

    static func session(in url: URL) -> String? {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard !items.contains(where: { $0.name == "cwd" }), items.filter({ $0.name == "session" }).count == 1 else { return nil }
        return items.first { $0.name == "session" }?.value
    }

    static func destination(from current: URL, endpoint: PiEndpoint, sessionID: String?) throws -> URL {
        guard isPiPage(current, endpoint: endpoint), var parts = URLComponents(url: current, resolvingAgainstBaseURL: false) else {
            throw ChromeNavigationError.tabChanged
        }
        guard let sessionID, session(in: current) != sessionID else { return current }
        // Keep the existing page's sidebar/layout parameters. Do not reload a matching session.
        var items = (parts.queryItems ?? []).filter { $0.name != "session" && $0.name != "cwd" }
        items.append(URLQueryItem(name: "session", value: sessionID))
        parts.queryItems = items
        parts.fragment = nil
        guard let url = parts.url else { throw ChromeNavigationError.tabChanged }
        return url
    }
}

/// Value-only snapshots: never share mutable Apple-event descriptors between tasks.
struct PiChromeLocation: Equatable {
    let windowID: String
    let tabID: String
    let index: Int
    let url: URL
    let active: Bool
}

struct PiChromeCache {
    let pid: pid_t
    let created: TimeInterval
    let locations: [PiChromeLocation]
    func valid(for currentPID: pid_t, now: TimeInterval) -> [PiChromeLocation]? {
        pid == currentPID && now >= created && now - created < 8 ? locations : nil
    }
}

enum PiMenuFragment: Equatable {
    case absent, invalid
    case ready(page: String), request(page: String, nonce: String, session: String), ack(page: String, nonce: String)

    static func parse(_ url: URL) -> PiMenuFragment {
        guard let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedFragment, !fragment.isEmpty else { return .absent }
        var components = URLComponents()
        components.percentEncodedQuery = fragment
        let items = components.queryItems ?? []
        guard items.contains(where: { $0.name == "pi-menu" }) else { return .absent }
        guard items.allSatisfy({ $0.value != nil }), Set(items.map(\.name)).count == items.count else { return .invalid }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value!) })
        guard values["pi-menu"] == "1", let page = values["page"], UUID(uuidString: page) != nil else { return .invalid }
        let keys = Set(values.keys)
        if keys == ["pi-menu", "page"] { return .ready(page: page) }
        if keys == ["pi-menu", "page", "ack"], let nonce = values["ack"], UUID(uuidString: nonce) != nil { return .ack(page: page, nonce: nonce) }
        if keys == ["pi-menu", "page", "request", "session"], let nonce = values["request"], UUID(uuidString: nonce) != nil,
           let session = values["session"], validSession(session) { return .request(page: page, nonce: nonce, session: session) }
        return .invalid
    }
    static func validSession(_ session: String) -> Bool {
        session.range(of: "^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$", options: .regularExpression) != nil
    }
    static func requesting(from url: URL, page: String, nonce: String, session: String) throws -> URL {
        guard validSession(session), var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw ChromeNavigationError.bridgeUnavailable }
        parts.fragment = "pi-menu=1&page=\(page)&request=\(nonce)&session=\(session)"
        guard let result = parts.url else { throw ChromeNavigationError.bridgeUnavailable }
        return result
    }
}

enum ChromeNavigationError: LocalizedError {
    case chromeNotRunning, permissionDenied, diagnosticNotAuthorized, noPiTab, tabChanged, browserUnavailable
    case commandFailed(operation: String, code: Int32)
    case bridgeUnavailable, bridgeTimeout
    var errorDescription: String? {
        switch self {
        case .chromeNotRunning: return "请先在 Chrome 打开 Pi Web"
        case .permissionDenied: return "请在系统设置 → 隐私与安全性 → 自动化中，允许 Pi Menu Bar 控制 Chrome"
        case .diagnosticNotAuthorized: return "Chrome 尚未授权；只读诊断未请求新权限"
        case .noPiTab: return "未找到已打开的本机 Pi Web 标签页"
        case .tabChanged: return "目标标签页已变化，请再点一次"
        case .browserUnavailable: return "暂时无法切换 Chrome 标签页，请再试一次"
        case .bridgeUnavailable: return "网页切换入口尚未就绪，请在网页完成当前操作后再试"
        case .bridgeTimeout: return "网页未确认切换；未重发，也未标记已读"
        case let .commandFailed(operation, code): return "Chrome \(operation)失败（\(code)）"
        }
    }
}

/// Owns only short-lived Pi metadata on the main actor. Warming is menu-driven, never
/// a background browser watcher, and cannot request automation consent.
@MainActor
final class ChromeBrowserController {
    let endpoint: PiEndpoint
    private var cache: PiChromeCache?
    private var prewarmTask: Task<Void, Never>?
    init(endpoint: PiEndpoint) { self.endpoint = endpoint }

    func prewarm(trace: ((String) -> Void)? = nil) {
        guard prewarmTask == nil,
              let chrome = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").first else { return }
        let pid = chrome.processIdentifier
        let endpoint = endpoint
        let started = ProcessInfo.processInfo.systemUptime
        prewarmTask = Task {
            cache = try? await Task.detached(priority: .userInitiated) {
                let target = NSAppleEventDescriptor(processIdentifier: pid)
                guard let address = target.aeDesc,
                      AEDeterminePermissionToAutomateTarget(address, AEEventClass(kAECoreSuite), AEEventID(kAEGetData), false) == noErr else {
                    throw ChromeNavigationError.diagnosticNotAuthorized
                }
                let locations = try ChromeTabNavigator(endpoint: endpoint).navigate(sessionID: nil, target: target, prewarmOnly: true)
                return PiChromeCache(pid: pid, created: ProcessInfo.processInfo.systemUptime, locations: locations)
            }.value
            trace?(String(format: "Read-only prewarm: %.0f ms", (ProcessInfo.processInfo.systemUptime - started) * 1000))
            prewarmTask = nil
        }
    }
    func finishPrewarm() async { await prewarmTask?.value }

    func open(sessionID: String?, verifyOnly: Bool = false, requestPermission: Bool = true,
              trace: ((String) -> Void)? = nil) async throws {
        let started = ProcessInfo.processInfo.systemUptime
        await finishPrewarm()
        guard let chrome = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").first else {
            cache = nil
            throw ChromeNavigationError.chromeNotRunning
        }
        let pid = chrome.processIdentifier
        let cached = cache?.valid(for: pid, now: ProcessInfo.processInfo.systemUptime)
        let endpoint = endpoint
        do {
            let locations = try await Task.detached(priority: .userInitiated) {
                let target = NSAppleEventDescriptor(processIdentifier: pid)
                if cached == nil {
                    guard let address = target.aeDesc else { throw ChromeNavigationError.browserUnavailable }
                    let permission = AEDeterminePermissionToAutomateTarget(address, AEEventClass(kAECoreSuite), AEEventID(kAEGetData), !verifyOnly && requestPermission)
                    guard permission == noErr else {
                        throw ChromeTabNavigator.permissionError(Int(permission), verifyOnly: verifyOnly) ?? .browserUnavailable
                    }
                }
                return try ChromeTabNavigator(endpoint: endpoint).navigate(sessionID: sessionID, target: target,
                    verifyOnly: verifyOnly, trace: { message in
                        trace?(String(format: "+%.0f ms %@", (ProcessInfo.processInfo.systemUptime - started) * 1000, message))
                    }, cached: cached, activate: {
                        try DispatchQueue.main.sync {
                            guard !chrome.isTerminated, chrome.activate(options: []) else { throw ChromeNavigationError.browserUnavailable }
                        }
                    })
            }.value
            cache = PiChromeCache(pid: pid, created: ProcessInfo.processInfo.systemUptime, locations: locations)
        } catch {
            cache = nil
            throw error
        }
    }
}

/// Direct, typed Apple events from Chrome's installed scripting.sdef. No AppleScript,
/// JavaScript injection, keyboard/mouse automation, tab creation, or browser profile access.
/// The user explicitly authorized Chrome automation for Pi Web tab reuse.
struct ChromeTabNavigator {
    let endpoint: PiEndpoint
    typealias SendEvent = (NSAppleEventDescriptor) throws -> NSAppleEventDescriptor
    // Permission prompts belong only to the explicit preflight initiated by a user's click.
    // A revoked permission between preflight and send must not trigger another system prompt.
    static let sendOptions: NSAppleEventDescriptor.SendOptions = [
        .waitForReply, .neverInteract, .init(rawValue: UInt(kAEDoNotPromptForUserConsent))
    ]

    @MainActor
    func open(sessionID: String?, verifyOnly: Bool = false, requestPermission: Bool = true,
              trace: ((String) -> Void)? = nil) async throws {
        try await ChromeBrowserController(endpoint: endpoint).open(sessionID: sessionID, verifyOnly: verifyOnly,
                                                                   requestPermission: requestPermission, trace: trace)
    }

    @discardableResult
    func navigate(sessionID: String?, target: NSAppleEventDescriptor,
                  send: SendEvent? = nil, verifyOnly: Bool = false, trace: ((String) -> Void)? = nil,
                  cached: [PiChromeLocation]? = nil, prewarmOnly: Bool = false,
                  activate: () throws -> Void = {}, acknowledgementTimeout: TimeInterval = 2) throws -> [PiChromeLocation] {
        let deadline = Date().addingTimeInterval(10)
        let transport: SendEvent = send ?? { event in
            do { return try event.sendEvent(options: Self.sendOptions, timeout: min(3, max(0.1, deadline.timeIntervalSinceNow))) }
            catch {
                if let denied = Self.permissionError((error as NSError).code, verifyOnly: verifyOnly) { throw denied }
                throw ChromeNavigationError.browserUnavailable
            }
        }
        func command(_ eventID: AEEventID, object: NSAppleEventDescriptor, value: NSAppleEventDescriptor? = nil) throws -> NSAppleEventDescriptor {
            guard Date() < deadline, !(verifyOnly || prewarmOnly) || eventID == kAEGetData else { throw ChromeNavigationError.browserUnavailable }
            let operation = Self.operationName(eventID, object: object)
            trace?("SEND \(operation)")
            let event = NSAppleEventDescriptor(eventClass: AEEventClass(kAECoreSuite), eventID: eventID,
                                              targetDescriptor: target, returnID: AEReturnID(kAutoGenerateReturnID),
                                              transactionID: AETransactionID(kAnyTransactionID))
            event.setParam(object, forKeyword: AEKeyword(keyDirectObject))
            if let value { event.setParam(value, forKeyword: AEKeyword(keyAEData)) }
            let reply = try transport(event)
            if let error = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber)), error.int32Value != 0 {
                trace?("ERROR \(operation): \(error.int32Value)")
                throw Self.permissionError(Int(error.int32Value), verifyOnly: verifyOnly) ?? .commandFailed(operation: operation, code: error.int32Value)
            }
            let value = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)) ?? NSAppleEventDescriptor.null()
            trace?("OK \(operation), type=\(value.descriptorType), items=\(value.numberOfItems)")
            return value
        }
        func get(_ object: NSAppleEventDescriptor) throws -> NSAppleEventDescriptor { try command(AEEventID(kAEGetData), object: object) }
        func set(_ object: NSAppleEventDescriptor, _ value: NSAppleEventDescriptor) throws {
            _ = try command(AEEventID(kAESetData), object: object, value: value)
        }
        func url(of object: NSAppleEventDescriptor) throws -> URL? {
            guard let text = try get(Self.property("URL ", of: object)).stringValue else { return nil }
            return URL(string: text)
        }

        func scan() throws -> [PiChromeLocation] {
            let windows = Self.items(try get(Self.elements("cwin")))
            var locations: [PiChromeLocation] = []
            // Only Pi locations survive this read-only scan. No titles, bodies or cookies.
            for windowReference in windows.prefix(100) {
                guard let windowID = try get(Self.property("ID  ", of: windowReference)).stringValue, !windowID.isEmpty else { continue }
                let window = Self.object("cwin", id: NSAppleEventDescriptor(string: windowID))
                let allTabs = Self.elements("CrTb", of: window)
                let addresses = Self.items(try get(Self.property("URL ", of: allTabs)))
                let piURLs = addresses.enumerated().prefix(1000).compactMap { offset, address -> (Int, URL)? in
                    guard let text = address.stringValue, let url = URL(string: text), PiBrowserPolicy.isPiPage(url, endpoint: endpoint) else { return nil }
                    return (offset, url)
                }
                guard !piURLs.isEmpty else { continue }
                let activeIndex = try get(Self.property("acTI", of: window)).int32Value
                let ids = Self.items(try get(Self.property("ID  ", of: allTabs)))
                guard ids.count == addresses.count else { throw ChromeNavigationError.tabChanged }
                for (offset, tabURL) in piURLs {
                    guard let tabID = ids[offset].stringValue, !tabID.isEmpty else { continue }
                    locations.append(PiChromeLocation(windowID: windowID, tabID: tabID, index: offset + 1,
                                                       url: tabURL, active: offset + 1 == Int(activeIndex)))
                }
            }
            trace?("Pi matches=\(locations.count)")
            return locations
        }
        func choose(_ locations: [PiChromeLocation]) -> PiChromeLocation? {
            let tabs = locations.map { PiBrowserTab(id: $0.tabID, url: $0.url, active: $0.active) }
            guard let tab = PiBrowserPolicy.choose(tabs, endpoint: endpoint, sessionID: sessionID) else { return nil }
            return locations.first { $0.tabID == tab.id }
        }
        func checked(_ location: PiChromeLocation, active: Bool = false, address: URL? = nil) -> NSAppleEventDescriptor {
            Self.checkedWindow(id: NSAppleEventDescriptor(string: location.windowID), tabID: location.tabID,
                               url: address ?? location.url, index: active ? nil : location.index)
        }
        func validate(_ location: PiChromeLocation) throws -> Bool {
            guard PiBrowserPolicy.isPiPage(location.url, endpoint: endpoint) else { return false }
            return try Self.items(get(checked(location))).count == 1
        }
        if prewarmOnly { return try scan() }
        var selection: PiChromeLocation?
        if let cached, let candidate = choose(cached) {
            do {
                if try validate(candidate) { selection = candidate; trace?("Cache hit") }
            } catch ChromeNavigationError.commandFailed(_, let code) where code == -1728 {
                // A closed cached object may be reported as missing instead of an empty list.
            }
        }
        if selection == nil {
            guard let candidate = try choose(scan()) else { throw ChromeNavigationError.noPiTab }
            guard try validate(candidate) else { throw ChromeNavigationError.tabChanged }
            selection = candidate
        }
        let selected = selection!
        if verifyOnly { trace?("Conditional window matches=1"); return [selected] }
        let currentURL = selected.url
        let fragment = PiMenuFragment.parse(currentURL)
        if sessionID != nil {
            switch fragment {
            case .request, .invalid: throw ChromeNavigationError.bridgeUnavailable
            default: break
            }
        }
        var destination = currentURL
        var bridge: (page: String, nonce: String, session: String)?
        if let sessionID, PiBrowserPolicy.session(in: currentURL) != sessionID {
            switch fragment {
            case .ready(let page), .ack(let page, _):
                let nonce = UUID().uuidString.lowercased()
                destination = try PiMenuFragment.requesting(from: currentURL, page: page, nonce: nonce, session: sessionID)
                bridge = (page, nonce, sessionID)
            case .absent:
                destination = try PiBrowserPolicy.destination(from: currentURL, endpoint: endpoint, sessionID: sessionID)
            case .request, .invalid: throw ChromeNavigationError.bridgeUnavailable
            }
        }
        // Every setter retains an execution-time ID + URL guard. One conditional read
        // replaces separate active-tab, ID and URL round trips without weakening it.
        try set(Self.property("acTI", of: checked(selected)), NSAppleEventDescriptor(int32: Int32(selected.index)))
        let focusedWindow = checked(selected, active: true)
        try set(Self.property("pmnd", of: focusedWindow), NSAppleEventDescriptor(boolean: false))
        try set(Self.property("pidx", of: focusedWindow), NSAppleEventDescriptor(int32: 1))
        guard try Self.items(get(focusedWindow)).count == 1 else { throw ChromeNavigationError.tabChanged }
        try activate()
        trace?("Chrome activation accepted")
        var finalURL = currentURL
        if destination != currentURL {
            let examined = Self.examinedObject()
            let checkedTab = Self.matching("CrTb", of: focusedWindow, conditions: [
                (Self.property("ID  ", of: examined), NSAppleEventDescriptor(string: selected.tabID)),
                (Self.property("URL ", of: examined), NSAppleEventDescriptor(string: currentURL.absoluteString))
            ])
            try set(Self.property("URL ", of: checkedTab), NSAppleEventDescriptor(string: destination.absoluteString))
            let window = Self.object("cwin", id: NSAppleEventDescriptor(string: selected.windowID))
            let tab = Self.object("CrTb", id: NSAppleEventDescriptor(string: selected.tabID), of: window)
            if let bridge {
                let expires = Date().addingTimeInterval(acknowledgementTimeout)
                while true {
                    guard let observed = try url(of: tab), PiBrowserPolicy.isPiPage(observed, endpoint: endpoint) else { throw ChromeNavigationError.tabChanged }
                    if PiMenuFragment.parse(observed) == .ack(page: bridge.page, nonce: bridge.nonce),
                       PiBrowserPolicy.session(in: observed) == bridge.session {
                        finalURL = observed
                        break
                    }
                    guard observed == destination else { throw ChromeNavigationError.tabChanged }
                    guard Date() < expires else { throw ChromeNavigationError.bridgeTimeout }
                    Thread.sleep(forTimeInterval: 0.02)
                }
                trace?("Page acknowledged same-document selection")
            } else {
                guard try url(of: tab) == destination else { throw ChromeNavigationError.tabChanged }
                finalURL = destination
                trace?("Legacy page query navigation accepted")
            }
            guard try Self.items(get(checked(selected, active: true, address: finalURL))).count == 1 else { throw ChromeNavigationError.tabChanged }
        }
        return [PiChromeLocation(windowID: selected.windowID, tabID: selected.tabID, index: selected.index, url: finalURL, active: true)]
    }

    static func permissionError(_ code: Int, verifyOnly: Bool) -> ChromeNavigationError? {
        guard code == Int(errAEEventNotPermitted) || code == Int(errAEEventWouldRequireUserConsent) else { return nil }
        return verifyOnly ? .diagnosticNotAuthorized : .permissionDenied
    }
    private static func operationName(_ eventID: AEEventID, object: NSAppleEventDescriptor) -> String {
        let wanted = object.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue
        let kind: String
        if wanted == fourCC("prop") {
            let property = object.forKeyword(AEKeyword(keyAEKeyData))?.typeCodeValue
            kind = [fourCC("ID  "): "标识", fourCC("URL "): "标签地址", fourCC("acTI"): "标签位置",
                    fourCC("acTa"): "当前标签", fourCC("pmnd"): "窗口最小化", fourCC("pidx"): "窗口顺序"][property ?? 0] ?? "属性"
        } else { kind = wanted == fourCC("cwin") ? "窗口列表" : "标签列表" }
        return (eventID == kAEGetData ? "读取" : "设置") + kind
    }
    static func fourCC(_ value: String) -> OSType {
        precondition(value.utf8.count == 4)
        return value.utf8.reduce(0) { ($0 << 8) | OSType($1) }
    }
    static func property(_ name: String, of container: NSAppleEventDescriptor) -> NSAppleEventDescriptor {
        specifier(wanted: "prop", form: "prop", data: NSAppleEventDescriptor(typeCode: fourCC(name)), container: container)
    }
    static func elements(_ kind: String, of container: NSAppleEventDescriptor = .null()) -> NSAppleEventDescriptor {
        let ordinal = NSAppleEventDescriptor(descriptorType: DescType(typeAbsoluteOrdinal),
                                             data: NSAppleEventDescriptor(enumCode: fourCC("all ")).data)!
        return specifier(wanted: kind, form: "indx", data: ordinal, container: container)
    }
    static func object(_ kind: String, id: NSAppleEventDescriptor, of container: NSAppleEventDescriptor = .null()) -> NSAppleEventDescriptor {
        specifier(wanted: kind, form: "ID  ", data: id, container: container)
    }
    private static func examinedObject() -> NSAppleEventDescriptor {
        NSAppleEventDescriptor(descriptorType: DescType(typeObjectBeingExamined), data: Data())!
    }
    private static func checkedWindow(id: NSAppleEventDescriptor, tabID: String, url: URL, index: Int? = nil) -> NSAppleEventDescriptor {
        let window = examinedObject()
        let tab = index.map { specifier(wanted: "CrTb", form: "indx", data: NSAppleEventDescriptor(int32: Int32($0)), container: window) }
            ?? property("acTa", of: window)
        return matching("cwin", conditions: [
            (property("ID  ", of: window), id),
            (property("ID  ", of: tab), NSAppleEventDescriptor(string: tabID)),
            (property("URL ", of: tab), NSAppleEventDescriptor(string: url.absoluteString))
        ])
    }
    private static func matching(_ kind: String, of container: NSAppleEventDescriptor = .null(),
                                 conditions: [(NSAppleEventDescriptor, NSAppleEventDescriptor)]) -> NSAppleEventDescriptor {
        let terms = NSAppleEventDescriptor.list()
        for (index, pair) in conditions.enumerated() {
            let comparison = NSAppleEventDescriptor.record()
            comparison.setDescriptor(NSAppleEventDescriptor(enumCode: OSType(kAEEquals)), forKeyword: AEKeyword(keyAECompOperator))
            comparison.setDescriptor(pair.0, forKeyword: AEKeyword(keyAEObject1))
            comparison.setDescriptor(pair.1, forKeyword: AEKeyword(keyAEObject2))
            terms.insert(comparison.coerce(toDescriptorType: DescType(typeCompDescriptor))!, at: index + 1)
        }
        let conjunction = NSAppleEventDescriptor.record()
        conjunction.setDescriptor(NSAppleEventDescriptor(enumCode: OSType(kAEAND)), forKeyword: AEKeyword(keyAELogicalOperator))
        conjunction.setDescriptor(terms, forKeyword: AEKeyword(keyAELogicalTerms))
        return specifier(wanted: kind, form: "test", data: conjunction.coerce(toDescriptorType: DescType(typeLogicalDescriptor))!, container: container)
    }
    private static func specifier(wanted: String, form: String, data: NSAppleEventDescriptor,
                                  container: NSAppleEventDescriptor) -> NSAppleEventDescriptor {
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(NSAppleEventDescriptor(typeCode: fourCC(wanted)), forKeyword: AEKeyword(keyAEDesiredClass))
        record.setDescriptor(NSAppleEventDescriptor(enumCode: fourCC(form)), forKeyword: AEKeyword(keyAEKeyForm))
        record.setDescriptor(data, forKeyword: AEKeyword(keyAEKeyData))
        record.setDescriptor(container, forKeyword: AEKeyword(keyAEContainer))
        return record.coerce(toDescriptorType: DescType(typeObjectSpecifier))!
    }
    static func items(_ descriptor: NSAppleEventDescriptor) -> [NSAppleEventDescriptor] {
        guard descriptor.descriptorType != typeNull else { return [] }
        guard descriptor.descriptorType == typeAEList else { return [descriptor] }
        return (0..<descriptor.numberOfItems).compactMap { descriptor.atIndex($0 + 1) }
    }
}
