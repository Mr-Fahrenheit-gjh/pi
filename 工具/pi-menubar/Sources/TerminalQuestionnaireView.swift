import SwiftUI

struct TerminalQuestionnaireView: View {
    let prompt: TerminalPrompt
    let connected: Bool
    let phase: TerminalSubmissionPhase?
    let submit: ([TerminalAnswer]?, Bool) -> Void
    @State private var selections: [Int: Set<Int>] = [:]
    @State private var drafts: [Int: String] = [:]

    private var enabled: Bool {
        connected && prompt.isRespondable && (phase == nil || phase == .rejected)
    }
    private var answers: [TerminalAnswer] {
        (prompt.questions ?? []).enumerated().map { index, _ in
            let indexes = (selections[index] ?? []).sorted()
            let draft = drafts[index] ?? ""
            return TerminalAnswer(questionIndex: index, optionIndexes: indexes.isEmpty ? nil : indexes,
                                  text: draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : draft)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let questions = prompt.questions {
                ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                    VStack(alignment: .leading, spacing: 7) {
                        if questions.count > 1 || !question.header.isEmpty {
                            MenuAccentTextForTerminal(text: questions.count > 1 ? "\(index + 1)/\(questions.count) · \(question.header)" : question.header)
                        }
                        Text(question.question).font(.system(size: 13, weight: .semibold)).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        if question.multiSelect {
                            Text("可多选，也可填写自定义答案").font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                            Button {
                                if question.multiSelect {
                                    var selected = selections[index] ?? []
                                    if selected.contains(optionIndex) { selected.remove(optionIndex) } else { selected.insert(optionIndex) }
                                    selections[index] = selected
                                } else {
                                    selections[index] = [optionIndex]
                                    drafts[index] = ""
                                }
                            } label: {
                                TerminalOptionLabel(option: option, selected: (selections[index] ?? []).contains(optionIndex))
                            }.buttonStyle(BlueMenuButtonStyle(card: true)).disabled(!enabled)
                        }
                        if prompt.isRespondable {
                            TextField("自定义回答", text: Binding(
                                get: { drafts[index] ?? "" },
                                set: { value in
                                    drafts[index] = value
                                    if !question.multiSelect && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                        selections[index] = []
                                    }
                                }), axis: .vertical)
                                .textFieldStyle(.roundedBorder).font(.system(size: 12)).lineLimit(1...5).disabled(!enabled)
                        }
                    }
                }
            }
            if let status = statusText {
                Text(status).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if prompt.isRespondable {
                HStack {
                    Button("拒绝问答") { submit(nil, true) }.disabled(!enabled)
                    Spacer(minLength: 0)
                    Button("提交回答") { submit(answers, false) }
                        .disabled(!enabled || !TerminalAnswerValidator.valid(answers, questions: prompt.questions ?? []))
                }.font(.system(size: 11)).buttonStyle(BlueMenuButtonStyle())
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusText: String? {
        if !connected { return "终端连接已断开，请回终端核对；不会自动重发。" }
        if prompt.hasPreview { return "此问答包含富预览，请在终端查看并回答。" }
        if prompt.questions == nil { return "题目无法完整同步，请在终端处理。" }
        switch phase {
        case .sending: return "正在发送…"
        case .accepted: return "终端已接收，等待同步。"
        case .rejected: return "终端未接受此回答，请检查后再试。"
        case .uncertain: return "发送结果未确认，请回终端核对；不会自动重发。"
        case nil: return prompt.canRespond ? nil : "终端正在处理，请稍候或回终端核对。"
        }
    }
}

private struct TerminalOptionLabel: View {
    let option: TerminalOption
    let selected: Bool
    @Environment(\.menuHighlighted) private var highlighted
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 12)).padding(.top, 2)
                .foregroundStyle(highlighted ? Color.white : Color(nsColor: .systemOrange))
            VStack(alignment: .leading, spacing: 4) {
                Text(option.label).font(.system(size: 12, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                if !option.description.isEmpty {
                    Text(option.description).font(.system(size: 11)).lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }.multilineTextAlignment(.leading).padding(9).frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MenuAccentTextForTerminal: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 11, weight: .medium)).foregroundStyle(Color(nsColor: .systemOrange))
            .fixedSize(horizontal: false, vertical: true)
    }
}
