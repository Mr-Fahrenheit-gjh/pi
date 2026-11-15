import Foundation

@main struct TerminalBridgeTests {
    @MainActor static func main() async {
        let directory = CommandLine.arguments[1]
        let suite = "pi-terminal-wire-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = PiStore(endpoint: try! PiEndpoint("http://127.0.0.1:30141"), defaults: defaults,
                            cookieProvider: { [] }, terminalDirectory: directory,
                            terminalNotificationSender: { _, _, _ in true }, terminalNotificationRemover: { _ in })
        var target: TerminalTarget?
        var sawAccepted = false
        var completion: CheckedContinuation<Bool, Never>?
        var finished = false
        func finish(_ ok: Bool) {
            guard !finished else { return }
            finished = true
            completion?.resume(returning: ok)
            completion = nil
        }
        store.onChange = {
            if let target {
                if store.terminalSubmissions[target]?.phase == .accepted { sawAccepted = true }
                if sawAccepted && store.terminalSessions[target.instance] == nil { finish(true) }
                return
            }
            guard let session = store.terminalAwaiting.first, let prompt = session.snapshot.prompts.first else { return }
            guard session.snapshot.sessionId == "terminal-session", prompt.toolCallId == "wire-test",
                  prompt.questions?.count == 2, prompt.isRespondable,
                  prompt.questions?[1].multiSelect == true,
                  prompt.questions?[0].options[0].description == "原始说明" else { finish(false); return }
            let current = TerminalTarget(instance: session.instance, generation: session.generation,
                                         sessionID: session.snapshot.sessionId, toolCallID: prompt.toolCallId)
            target = current
            let answers = [TerminalAnswer(questionIndex: 0, optionIndexes: [1], text: nil),
                           TerminalAnswer(questionIndex: 1, optionIndexes: [0, 1], text: " 自定义 ")]
            store.submitTerminal(current, answers: answers)
            guard store.terminalSubmissions[current]?.phase == .sending else { finish(false); return }
            // A second action cannot race the already locked submission.
            store.submitTerminal(current, cancel: true)
        }
        let result = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            completion = continuation
            store.startTerminalMonitoring()
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                finish(false)
            }
        }
        store.onChange = nil
        store.stop()
        if !result { fputs("FAIL: PiStore/Node terminal bridge\n", stderr); exit(1) }
        print("PASS: Swift/Node terminal bridge snapshot, explicit PiStore answer, lock and verdict")
    }
}
