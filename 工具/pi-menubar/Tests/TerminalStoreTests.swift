import Foundation

@main struct TerminalStoreTests {
    @MainActor static func main() async throws {
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            if !condition() { fputs("FAIL: \(message)\n", stderr); exit(1) }
        }
        let suite = "pi-terminal-tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        var sent: [(String, String, String)] = []
        var removed: [String] = []
        let store = PiStore(endpoint: try PiEndpoint("http://127.0.0.1:30141"), defaults: defaults,
            cookieProvider: { [] }, terminalNotificationSender: { key, title, session in
                sent.append((key, title, session)); return true
            }, terminalNotificationRemover: { removed.append(contentsOf: $0) })
        let instance = UUID(), generation = UUID(), later = UUID()
        let options = [TerminalOption(label: "是", description: "原始说明", hasPreview: false),
                       TerminalOption(label: "否", description: "不继续", hasPreview: false)]
        let question = TerminalQuestion(question: "是否继续？", header: "确认", multiSelect: false, options: options)
        let multi = TerminalQuestion(question: "选择哪些？", header: "多选", multiSelect: true, options: options)
        let first = TerminalPrompt(toolCallId: "first", questions: [question, multi], unavailable: nil, canRespond: true)
        let second = TerminalPrompt(toolCallId: "second", questions: [question], unavailable: nil, canRespond: true)
        func snapshot(_ prompts: [TerminalPrompt]) -> TerminalSnapshot {
            TerminalSnapshot(type: "snapshot", version: 1, instanceId: instance.uuidString.lowercased(),
                             sessionId: "session", title: "终端测试", project: "project", prompts: prompts)
        }
        let answers = [TerminalAnswer(questionIndex: 0, optionIndexes: [1], text: nil),
                       TerminalAnswer(questionIndex: 1, optionIndexes: [0, 1], text: " 自定义 ")]
        check(TerminalAnswerValidator.valid(answers, questions: [question, multi]), "multiple and custom answers supported")
        check(!TerminalAnswerValidator.valid([answers[0], answers[0]], questions: [question, multi]), "duplicate question rejected")
        check(!TerminalAnswerValidator.valid([TerminalAnswer(questionIndex: 0, optionIndexes: [0], text: "both")], questions: [question]), "single select cannot mix text and option")
        check(!TerminalAnswerValidator.valid([TerminalAnswer(questionIndex: 0, optionIndexes: [2], text: nil)], questions: [question]), "invalid option rejected")
        check(!TerminalAnswerValidator.valid([TerminalAnswer(questionIndex: 0, optionIndexes: nil, text: "  ")], questions: [question]), "blank custom text rejected")

        store.handleTerminalEvent(.snapshot(snapshot([first, second]), instance, generation))
        for _ in 0..<30 { await Task.yield() }
        check(store.awaitingCount == 1 && store.terminalAwaiting[0].connected, "terminal session joins pending count")
        check(sent.count == 2 && Set(sent.map(\.0)).count == 2, "one notification per terminal question")
        check(sent.allSatisfy { $0.1 == "终端测试" && $0.2.hasPrefix("terminal:") }, "notification opens terminal entry without question content")
        store.handleTerminalEvent(.snapshot(snapshot([first, second]), instance, generation))
        for _ in 0..<30 { await Task.yield() }
        check(sent.count == 2, "snapshot replay does not duplicate notifications")
        store.handleTerminalEvent(.disconnected(instance, generation))
        check(store.awaitingCount == 1 && !store.terminalAwaiting[0].connected, "disconnect preserves a disabled pending row")
        check(removed.isEmpty, "disconnect is not treated as an answer")
        store.handleTerminalEvent(.snapshot(snapshot([first, second]), instance, later))
        for _ in 0..<30 { await Task.yield() }
        check(store.terminalAwaiting[0].connected && sent.count == 2, "reconnect restores from snapshot without duplicate notification")
        store.handleTerminalEvent(.snapshot(snapshot([second]), instance, later))
        check(removed.count == 1 && removed[0].hasSuffix(":first"), "only resolved notification removed")
        store.handleTerminalEvent(.closed(instance, later))
        check(store.awaitingCount == 0 && removed.contains { $0.hasSuffix(":second") }, "session close clears remaining notification")

        let preview = TerminalPrompt(toolCallId: "preview", questions: [TerminalQuestion(question: "Q", header: "H", multiSelect: false,
            options: [TerminalOption(label: "A", description: "A", hasPreview: true), options[1]])], unavailable: nil, canRespond: false)
        check(!preview.isRespondable && preview.hasPreview, "rich preview cannot be answered without seeing it")

        for firstDeliverySucceeds in [true, false] {
            let raceInstance = UUID(), oldGeneration = UUID(), newGeneration = UUID()
            let raceSnapshot = TerminalSnapshot(type: "snapshot", version: 1, instanceId: raceInstance.uuidString.lowercased(),
                                                sessionId: "race", title: "通知竞态", project: "project", prompts: [second])
            var deliveries = 0
            var removals: [String] = []
            var release: CheckedContinuation<Void, Never>?
            let raceStore = PiStore(endpoint: try PiEndpoint("http://127.0.0.1:30141"), defaults: defaults,
                cookieProvider: { [] }, terminalNotificationSender: { _, _, _ in
                    deliveries += 1
                    if deliveries == 1 {
                        await withCheckedContinuation { release = $0 }
                        return firstDeliverySucceeds
                    }
                    return true
                }, terminalNotificationRemover: { removals.append(contentsOf: $0) })
            raceStore.handleTerminalEvent(.snapshot(raceSnapshot, raceInstance, oldGeneration))
            for _ in 0..<30 { await Task.yield() }
            check(release != nil, "first notification is in flight")
            raceStore.handleTerminalEvent(.disconnected(raceInstance, oldGeneration))
            raceStore.handleTerminalEvent(.snapshot(raceSnapshot, raceInstance, newGeneration))
            for _ in 0..<30 { await Task.yield() }
            check(deliveries == 1, "reconnect waits for the in-flight notification")
            release?.resume(); release = nil
            for _ in 0..<30 { await Task.yield() }
            check(deliveries == (firstDeliverySucceeds ? 1 : 2), "reconnect keeps a successful delivery or retries a failed old generation")
            check(removals.isEmpty && raceStore.awaitingCount == 1, "reconnect does not remove a still-pending notification")
            raceStore.handleTerminalEvent(.closed(raceInstance, newGeneration))
            raceStore.stop()
        }
        store.stop()
        print("PASS: terminal notifications, deduplication, reconnect delivery races, preview and answer validation")
    }
}
