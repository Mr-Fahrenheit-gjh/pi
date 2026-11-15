import AppKit
import SwiftUI

@main struct RenderProbe {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do {
                let suite = "cn.pi.menubar.render.\(UUID().uuidString)"
                let defaults = UserDefaults(suiteName: suite)!
                defer { defaults.removePersistentDomain(forName: suite) }
                let store = PiStore(endpoint: try PiEndpoint("http://127.0.0.1:30141"), defaults: defaults, cookieProvider: { [] })
                await store.refresh() // Read only; never start polling or request notification permission.
                defer { store.stop() }
                let menu = MenuView(store: store, openBrowser: { _ in fatalError("Render probe must not navigate") })
                let panel = GlassPanel(content: menu.environment(\.colorScheme, .light))
                panel.setFrameOrigin(NSPoint(x: -5000, y: -5000))
                panel.orderFront(nil)
                try await Task.sleep(nanoseconds: 150_000_000)
                try snapshot(panel.contentView!, to: "build/menu-overview-preview.png")
                precondition(panel.frame.size == NSSize(width: 280, height: 454), "Single-row menus must still keep their height")
                panel.close()

                let presentation = ApprovalOptionText("原生菜单 (Recommended) — 保留完整说明 — 不改答案")
                precondition(presentation.title == "原生菜单" && presentation.recommended && presentation.detail == "保留完整说明 — 不改答案")
                let opaque = ApprovalOptionText("不猜测 / 多选 A、B / 自定义")
                precondition(opaque.title == "不猜测 / 多选 A、B / 自定义" && opaque.detail == nil && !opaque.recommended)
                let event = try JSONDecoder().decode(ApprovalEvent.self, from: Data("""
                {"type":"extension_ui_request","id":"sample","method":"select","title":"接下来采用哪种方式？","options":["原生菜单 (Recommended) — 在菜单中直接选择，选完即可继续。","打开网页 — 需要查看完整上下文时使用。","Type something."]}
                """.utf8))
                let item = PendingApproval(id: ApprovalTarget(origin: store.endpoint.base.absoluteString, sessionID: "sample", requestID: "sample"),
                                           request: ApprovalRequest(event), phase: .ready, order: 0)
                precondition(item.request.response(id: "sample", answer: .value(item.request.options![0]))?.value == item.request.options![0],
                             "Presentation must never rewrite the submitted raw option")
                let preview = VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 3) {
                        Button {} label: { Text("进行中 1").frame(maxWidth: .infinity).padding(.vertical, 6) }
                        Button {} label: { Text("待审批 1").frame(maxWidth: .infinity).padding(.vertical, 6) }
                            .buttonStyle(BlueMenuButtonStyle(selected: true))
                        Button {} label: { Text("未读 0").frame(maxWidth: .infinity).padding(.vertical, 6) }
                    }.font(.system(size: 12)).buttonStyle(BlueMenuButtonStyle())
                    Text("Pi 菜单栏设计").font(.system(size: 12)).foregroundStyle(.secondary)
                    Color.primary.opacity(0.07).frame(height: 0.5)
                    ApprovalForm(item: item, submit: { _ in fatalError("Render probe must not submit") }, openBrowser: {})
                }.padding(16).frame(width: 280).environment(\.colorScheme, .light)
                let form = NSHostingView(rootView: preview)
                form.frame.size = form.fittingSize
                let questionPanel = GlassPanel(content: preview)
                questionPanel.setContentSize(form.fittingSize)
                questionPanel.setFrameOrigin(NSPoint(x: -5000, y: -5000))
                questionPanel.orderFront(nil)
                try await Task.sleep(nanoseconds: 200_000_000)
                try snapshot(questionPanel.contentView!, to: "build/menu-approval-preview.png")
                questionPanel.close()

                let options = [TerminalOption(label: "保留终端原意", description: "显示完整选项说明。", hasPreview: false),
                               TerminalOption(label: "自定义", description: "也可以填写其他回答。", hasPreview: false)]
                let questions = [TerminalQuestion(question: "终端会话接下来如何处理？", header: "确认", multiSelect: false, options: options),
                                 TerminalQuestion(question: "哪些选项同时适用？", header: "多选", multiSelect: true, options: options)]
                let terminalPrompt = TerminalPrompt(toolCallId: "render-only", questions: questions, unavailable: nil, canRespond: true)
                let terminalView = TerminalQuestionnaireView(prompt: terminalPrompt, connected: true, phase: nil,
                    submit: { _, _ in fatalError("Render probe must not submit") })
                    .padding(16).frame(width: 280).environment(\.colorScheme, .light)
                let terminalHost = NSHostingView(rootView: terminalView)
                terminalHost.frame.size = terminalHost.fittingSize
                let terminalPanel = GlassPanel(content: terminalView)
                terminalPanel.setContentSize(terminalHost.fittingSize)
                terminalPanel.setFrameOrigin(NSPoint(x: -5000, y: -5000))
                terminalPanel.orderFront(nil)
                try await Task.sleep(nanoseconds: 200_000_000)
                try snapshot(terminalPanel.contentView!, to: "build/menu-terminal-preview.png")
                terminalPanel.close()
                print("PASS: native overview, Web select and terminal multi-question views rendered; no navigation or approval submitted")
                exit(0)
            } catch { fputs("FAIL: \(error)\n", stderr); exit(1) }
        }
        app.run()
    }

    @MainActor private static func snapshot(_ view: NSView, to path: String) throws {
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw URLError(.zeroByteResource) }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw URLError(.zeroByteResource) }
        try png.write(to: URL(fileURLWithPath: path))
    }
}
