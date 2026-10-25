import SwiftUI
import UIKit

/// A permission the agent waits for, in place of the composer: what it wants
/// to do, in its own words, and the two answers.
struct ApprovalPanel: View {
  @Environment(AppModel.self) private var model
  let threadId: String
  let request: ApprovalView
  @State private var busy = false
  @State private var problem: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text(request.title)
          .font(.headline)
        Spacer()
        Button("Stop") { decide("abort") }
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .buttonStyle(.plain)
          .disabled(busy)
      }
      if let subject = request.subject {
        ScrollView(.horizontal, showsIndicators: false) {
          Text(subject)
            .font(.system(.subheadline, design: .monospaced))
            .lineLimit(6)
            .fixedSize(horizontal: true, vertical: true)
            .textSelection(.enabled)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.tertiary, in: .rect(cornerRadius: 14, style: .continuous))
      }
      if let reason = request.reason {
        Text(reason)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(4)
      }
      if let place = request.where {
        Text("In \(place)")
          .font(.footnote)
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }
      HStack(spacing: 10) {
        Button {
          decide("deny")
        } label: {
          Text("Deny").frame(maxWidth: .infinity)
        }
        .buttonStyle(.glass)
        Button {
          decide("approve")
        } label: {
          Text("Allow")
            .fontWeight(.semibold)
            .foregroundStyle(busy ? Color(.tertiaryLabel) : Color(.systemBackground))
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
      }
      .controlSize(.large)
      .disabled(busy)
      .padding(.top, 2)
      Button("Always allow in this chat") { decide("approve-session") }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .disabled(busy)
    }
    .padding(16)
    .glassEffect(.regular, in: .rect(cornerRadius: 26, style: .continuous))
    .problemAlert($problem)
  }

  private func decide(_ decision: String) {
    busy = true
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    Task {
      do {
        _ = try await model.request([
          "type": "thread.decide", "threadId": threadId, "approvalId": request.id, "decision": decision,
        ])
      } catch {
        problem = error.localizedDescription
        busy = false
      }
    }
  }
}

/// The agent's questions, one at a time, answered where the composer was.
struct QuestionPanel: View {
  @Environment(AppModel.self) private var model
  let threadId: String
  let request: QuestionsView
  @State private var index = 0
  @State private var chosen: [String: [String]] = [:]
  @State private var typed: [String: String] = [:]
  @State private var busy = false
  @State private var problem: String?
  @State private var optionsHeight: CGFloat = 0

  var body: some View {
    let question = request.questions[min(index, request.questions.count - 1)]
    let ready = !answer(question).isEmpty && !busy
    let last = index >= request.questions.count - 1
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text(question.header)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(.secondary)
        Spacer()
        if request.questions.count > 1 {
          Text("\(index + 1) of \(request.questions.count)")
            .font(.subheadline)
            .monospacedDigit()
            .foregroundStyle(.tertiary)
        }
      }
      Text(question.question)
        .font(.headline)
        .fixedSize(horizontal: false, vertical: true)
      if !question.options.isEmpty {
        ScrollView {
          VStack(spacing: 0) {
            ForEach(Array(question.options.enumerated()), id: \.offset) { offset, option in
              if offset > 0 { Divider() }
              optionRow(question, option)
            }
          }
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { optionsHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(max(optionsHeight, 1), 280))
      }
      if question.other {
        answerField(question)
      }
      HStack(spacing: 10) {
        if index > 0 {
          Button {
            withAnimation(.snappy) { index -= 1 }
          } label: {
            Text("Back").frame(maxWidth: .infinity)
          }
          .buttonStyle(.glass)
        }
        Button {
          if last {
            submit()
          } else {
            withAnimation(.snappy) { index += 1 }
          }
        } label: {
          Text(last ? "Send" : "Next")
            .fontWeight(.semibold)
            .foregroundStyle(ready ? Color(.systemBackground) : Color(.tertiaryLabel))
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .disabled(!ready)
      }
      .controlSize(.large)
    }
    .padding(16)
    .glassEffect(.regular, in: .rect(cornerRadius: 26, style: .continuous))
    .problemAlert($problem)
  }

  private func optionRow(_ question: QuestionView, _ option: OptionView) -> some View {
    let selected = chosen[question.id, default: []].contains(option.label)
    return Button {
      toggle(question, option.label)
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(option.label)
            .font(.body)
          Text(inlineMarkdown(option.detail, code: .system(.caption, design: .monospaced)))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
        Image(tabler: selected ? "circle-check-filled" : "circle", size: 22)
          .foregroundStyle(selected ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
      }
      .padding(.vertical, 10)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder private func answerField(_ question: QuestionView) -> some View {
    let binding = Binding(get: { typed[question.id] ?? "" }, set: { typed[question.id] = $0 })
    let prompt = question.options.isEmpty ? "Your answer" : "Something else"
    Group {
      if question.secret {
        SecureField(prompt, text: binding)
      } else {
        TextField(prompt, text: binding, axis: .vertical)
          .lineLimit(1...4)
      }
    }
    .font(.body)
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(.fill.tertiary, in: .rect(cornerRadius: 14, style: .continuous))
  }

  private func toggle(_ question: QuestionView, _ label: String) {
    UISelectionFeedbackGenerator().selectionChanged()
    var current = chosen[question.id, default: []]
    if question.multiple {
      if let at = current.firstIndex(of: label) { current.remove(at: at) } else { current.append(label) }
    } else {
      current = current == [label] ? [] : [label]
    }
    chosen[question.id] = current
  }

  private func answer(_ question: QuestionView) -> [String] {
    let other = typed[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return chosen[question.id, default: []] + (other.isEmpty ? [] : [other])
  }

  private func submit() {
    busy = true
    let answers = Dictionary(uniqueKeysWithValues: request.questions.map { ($0.id, answer($0)) })
    Task {
      do {
        _ = try await model.request([
          "type": "thread.answer", "threadId": threadId, "requestId": request.id, "answers": answers,
        ])
        UINotificationFeedbackGenerator().notificationOccurred(.success)
      } catch {
        problem = error.localizedDescription
        busy = false
      }
    }
  }
}
