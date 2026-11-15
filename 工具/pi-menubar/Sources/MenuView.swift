import SwiftUI

private extension SessionCategory {
    var accent: Color {
        switch self {
        case .active: return Color(nsColor: .systemTeal)
        case .awaiting: return Color(nsColor: .systemOrange)
        case .unread: return Color(nsColor: .systemPurple)
        }
    }
}

private struct MenuHighlightKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var menuHighlighted: Bool {
        get { self[MenuHighlightKey.self] }
        set { self[MenuHighlightKey.self] = newValue }
    }
}
private struct MenuAccentText: View {
    let text: String
    let accent: Color
    @Environment(\.menuHighlighted) private var highlighted
    var body: some View { Text(text).foregroundStyle(highlighted ? Color.white : accent) }
}

struct MenuView: View {
    @ObservedObject var store: PiStore
    let openBrowser: (String?) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 3) {
                categoryButton(.active, count: store.active.count)
                categoryButton(.awaiting, count: store.awaitingCount)
                categoryButton(.unread, count: store.unread.count)
            }.padding(.horizontal, 8).padding(.vertical, 10)
                .frame(height: PanelLayout.headerHeight)
                .overlay(alignment: .bottom) {
                    Color.primary.opacity(0.07).frame(height: 1).padding(.horizontal, 16)
                }
            ScrollView {
                VStack(alignment: .leading, spacing: 5) {
                    if let error = store.navigationError {
                        HStack(alignment: .top, spacing: 8) {
                            Text(error).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Button { store.navigationError = nil } label: { Image(systemName: "xmark").font(.system(size: 10)) }
                                .buttonStyle(.plain).help("关闭提示")
                        }.foregroundStyle(.secondary).padding(8)
                    }
                    if let error = store.connectionError {
                        Button { openBrowser(nil) } label: {
                            Label(error, systemImage: "wifi.exclamationmark")
                                .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                        }.buttonStyle(BlueMenuButtonStyle())
                    }
                    if store.visibleSessions.isEmpty && (store.category != .awaiting || store.terminalAwaiting.isEmpty) {
                        Text(emptyMessage).font(.system(size: 12)).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.vertical, 17)
                    } else {
                        if store.category == .awaiting && (store.focusedSessionID?.hasPrefix("terminal:") ?? false) { terminalRows }
                        ForEach(store.visibleSessions) { session in
                            VStack(alignment: .leading, spacing: 8) {
                                SessionRow(session: session, accent: store.category.accent) { openBrowser(session.id) }
                                    .disabled(store.navigating)
                                if store.category == .awaiting {
                                    let items = store.approvals.requests(for: session.id)
                                    if items.isEmpty {
                                        HStack {
                                            Text(store.approvals.isConnected(session.id) ? "正在同步问题…" : "正在连接…")
                                                .font(.system(size: 11)).foregroundStyle(.secondary)
                                            Spacer(minLength: 0)
                                            Button("网页处理") { openBrowser(session.id) }
                                                .buttonStyle(BlueMenuButtonStyle()).font(.system(size: 11))
                                        }.padding(.horizontal, 8).padding(.bottom, 8)
                                    }
                                    ForEach(items) { item in
                                        ApprovalForm(item: item, submit: { store.submit(item.id, answer: $0) },
                                                     openBrowser: { openBrowser(item.id.sessionID) })
                                            .id(item.id).padding(.horizontal, 8).padding(.bottom, 8)
                                    }
                                }
                            }
                        }
                        if store.category == .awaiting && !(store.focusedSessionID?.hasPrefix("terminal:") ?? false) { terminalRows }
                    }
                    if !store.recentHistory.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Rectangle().fill(Color.primary.opacity(0.07)).frame(height: 1)
                            Text("最近对话").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                        }.padding(.horizontal, 8).padding(.top, 10).padding(.bottom, 2)
                        ForEach(store.recentHistory) { session in
                            SessionRow(session: session, accent: Color.secondary) { openBrowser(session.id) }
                                .disabled(store.navigating)
                        }
                    }
                    if !store.notificationHint.isEmpty {
                        Button {
                            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
                        } label: {
                            Label("开启审批通知", systemImage: "bell.slash").font(.system(size: 11))
                                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(BlueMenuButtonStyle()).help(store.notificationHint)
                    }
                }.padding(.horizontal, 8).padding(.top, 10).padding(.bottom, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.frame(height: PanelLayout.contentHeight)
        }
        .frame(width: PanelLayout.width)
        .foregroundStyle(.primary).tint(Color(nsColor: .systemBlue))
    }

    private var terminalRows: some View {
        ForEach(store.terminalAwaiting) { session in
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session.snapshot.title).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                        MenuAccentText(text: "终端 · " + session.snapshot.project, accent: Color(nsColor: .systemOrange))
                            .font(.system(size: 11, weight: .medium)).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if !session.connected {
                        Button("移除失联提醒") { store.dismissDisconnectedTerminal(session.instance) }
                            .font(.system(size: 10)).buttonStyle(BlueMenuButtonStyle())
                    }
                }.padding(8)
                ForEach(session.snapshot.prompts) { prompt in
                    let target = TerminalTarget(instance: session.instance, generation: session.generation,
                                                sessionID: session.snapshot.sessionId, toolCallID: prompt.toolCallId)
                    TerminalQuestionnaireView(prompt: prompt, connected: session.connected,
                        phase: store.terminalSubmissions[target]?.phase,
                        submit: { answers, cancel in store.submitTerminal(target, answers: answers, cancel: cancel) })
                        .id(target).padding(.horizontal, 8).padding(.bottom, 8)
                }
            }
        }
    }

    private var emptyMessage: String {
        if !store.connected && store.connectionError == nil { return "正在连接…" }
        switch store.category {
        case .active: return "暂无进行中的对话"
        case .awaiting: return "暂无待审批"
        case .unread: return "没有未读对话"
        }
    }

    private func categoryButton(_ category: SessionCategory, count: Int) -> some View {
        Button { store.category = category; store.focusedSessionID = nil } label: {
            HStack(spacing: 4) {
                Text(category.rawValue)
                MenuAccentText(text: "\(count)", accent: category.accent.opacity(count > 0 ? 1 : 0.7))
                    .monospacedDigit().fontWeight(.semibold)
            }.font(.system(size: 12)).frame(maxWidth: .infinity).padding(.vertical, 7)
        }.buttonStyle(BlueMenuButtonStyle(selected: store.category == category))
            .accessibilityAddTraits(store.category == category ? .isSelected : [])
    }
}

/// Use the system menu blue for both selection and hover, not the user's accent tint.
struct BlueMenuButtonStyle: ButtonStyle {
    var selected = false
    var card = false
    func makeBody(configuration: Configuration) -> some View {
        HighlightedLabel(configuration: configuration, selected: selected, card: card)
    }
    private struct HighlightedLabel: View {
        let configuration: ButtonStyle.Configuration
        let selected: Bool
        let card: Bool
        @State private var hovered = false
        @Environment(\.isEnabled) private var enabled
        private var highlighted: Bool { selected || (enabled && (hovered || configuration.isPressed)) }
        var body: some View {
            configuration.label
                .environment(\.menuHighlighted, highlighted)
                .foregroundStyle(highlighted ? Color.white : Color.primary)
                .contentShape(Rectangle())
                .background(highlighted ? Color(nsColor: .systemBlue) : (card ? Color.primary.opacity(0.035) : Color.clear),
                            in: RoundedRectangle(cornerRadius: card ? 9 : 6))
                .overlay {
                    if card {
                        RoundedRectangle(cornerRadius: 9)
                            .strokeBorder(highlighted ? Color.clear : Color.primary.opacity(0.07), lineWidth: 0.5)
                    }
                }
                .opacity(enabled ? 1 : 0.6)
                .onHover { hovered = $0 }
        }
    }
}

private struct SessionRow: View {
    let session: PiSession
    let accent: Color
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.title).font(.system(size: 13)).lineLimit(2).multilineTextAlignment(.leading)
                    MenuAccentText(text: session.project + (session.isChild ? " · 子代理" : ""), accent: accent)
                        .font(.system(size: 11, weight: .medium)).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .medium)).opacity(0.6)
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(BlueMenuButtonStyle()).help(session.title)
    }
}

/// Presentation only: the button always submits the untouched original option.
struct ApprovalOptionText {
    let title: String
    let detail: String?
    let recommended: Bool
    init(_ value: String) {
        let separator = value.range(of: " — ")
        let label = separator.map { String(value[..<$0.lowerBound]) } ?? value
        detail = separator.map { String(value[$0.upperBound...]) }
        recommended = label.hasSuffix(" (Recommended)")
        title = recommended ? String(label.dropLast(" (Recommended)".count)) : label
    }
}

private struct ApprovalOptionLabel: View {
    let value: String
    @Environment(\.menuHighlighted) private var highlighted
    var body: some View {
        let text = ApprovalOptionText(value)
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(text.title).font(.system(size: 12, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if text.recommended {
                    Text("推荐").font(.system(size: 9, weight: .medium))
                        .foregroundStyle(highlighted ? Color.white : Color(nsColor: .systemTeal))
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background((highlighted ? Color.white : Color(nsColor: .systemTeal)).opacity(0.12), in: Capsule())
                }
            }
            if let detail = text.detail, !detail.isEmpty {
                MenuAccentText(text: detail, accent: .secondary)
                    .font(.system(size: 11)).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
            }
        }.multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading).padding(10)
    }
}

struct ApprovalForm: View {
    let item: PendingApproval
    let submit: (ApprovalAnswer) -> Void
    let openBrowser: () -> Void
    @State private var draft: String

    init(item: PendingApproval, submit: @escaping (ApprovalAnswer) -> Void, openBrowser: @escaping () -> Void) {
        self.item = item
        self.submit = submit
        self.openBrowser = openBrowser
        _draft = State(initialValue: item.request.prefill ?? "")
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let enabled = item.canRespond(at: context.date)
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    if let title = item.request.title {
                        Text(title).font(.system(size: 13, weight: .semibold)).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                    if let message = item.request.message, !message.isEmpty {
                        Text(message).font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                }.padding(.top, 4)
                if item.request.supportsNative {
                    controls.disabled(!enabled)
                    if let status = status(at: context.date) {
                        Text(status).font(.system(size: 11)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(spacing: 7) {
                        Color.primary.opacity(0.07).frame(height: 0.5)
                        HStack(spacing: 6) {
                            Button { submit(.cancel) } label: {
                                Text("取消").padding(.horizontal, 6).padding(.vertical, 5)
                            }.disabled(!enabled)
                            Spacer(minLength: 0)
                            Button(action: openBrowser) {
                                Text("网页处理 ↗").padding(.horizontal, 6).padding(.vertical, 5)
                            }
                        }.font(.system(size: 11)).buttonStyle(BlueMenuButtonStyle())
                    }
                } else {
                    Button(action: openBrowser) {
                        Label("在网页处理此审批", systemImage: "arrow.up.right")
                            .padding(9).frame(maxWidth: .infinity, alignment: .leading)
                    }.font(.system(size: 12)).buttonStyle(BlueMenuButtonStyle(card: true))
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var controls: some View {
        switch item.request.method {
        case "select":
            VStack(spacing: 7) {
                ForEach(Array((item.request.options ?? []).enumerated()), id: \.offset) { _, value in
                    Button { submit(.value(value)) } label: {
                        ApprovalOptionLabel(value: value)
                    }.buttonStyle(BlueMenuButtonStyle(card: true)).accessibilityLabel(value)
                }
            }
        case "confirm":
            HStack(spacing: 8) {
                Button { submit(.confirm(false)) } label: { Text("否").frame(maxWidth: .infinity).padding(.vertical, 9) }
                Button { submit(.confirm(true)) } label: { Text("是").frame(maxWidth: .infinity).padding(.vertical, 9) }
            }.font(.system(size: 12, weight: .medium)).buttonStyle(BlueMenuButtonStyle(card: true))
        case "input", "editor":
            VStack(alignment: .trailing, spacing: 8) {
                if item.request.method == "editor" {
                    TextEditor(text: $draft).font(.system(size: 12)).frame(height: 100)
                        .accessibilityLabel(item.request.title ?? "回答")
                } else {
                    TextField(item.request.placeholder ?? "输入回答", text: $draft, axis: .vertical)
                        .textFieldStyle(.roundedBorder).font(.system(size: 12))
                        .lineLimit(2...6).accessibilityLabel(item.request.title ?? "回答")
                }
                Button("发送") { submit(.value(draft)) }.buttonStyle(.borderedProminent).controlSize(.small)
            }
        default: EmptyView()
        }
    }

    private func status(at now: Date) -> String? {
        switch item.phase {
        case .sending: return "正在发送…"
        case .sent: return "已发送，处理结果以会话为准"
        case .uncertain: return "发送结果未确认，请在网页核对"
        default:
            if item.request.isExpired(at: now) || item.phase == .expired { return "请求已过期" }
            if item.phase == .syncing { return "连接已断开，正在同步…" }
            return nil
        }
    }
}
