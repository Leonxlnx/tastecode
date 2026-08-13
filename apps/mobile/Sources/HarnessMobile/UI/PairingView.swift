import SwiftUI
import UIKit

struct PairingWelcomeView: View {
  @EnvironmentObject private var model: AppModel
  @State private var link = ""
  @State private var scanning = false
  @State private var showingManualEntry = false
  @State private var pairing = false
  @State private var localError: String?

  var body: some View {
    ZStack {
      HarnessColor.background.ignoresSafeArea()
      if scanning {
        scanner
      } else {
        welcome
      }
    }
    .onChange(of: model.pairingLink) { _, value in
      guard let value else { return }
      link = value
      Task { await pair() }
    }
    .task {
      guard let initialLink = model.pairingLink, link.isEmpty else { return }
      link = initialLink
      await pair()
    }
    .alert(
      "Couldn’t pair",
      isPresented: Binding(
        get: { localError != nil },
        set: { if !$0 { localError = nil } }
      )
    ) {
      Button("OK", role: .cancel) { localError = nil }
    } message: {
      Text(localError ?? "")
    }
  }

  private var welcome: some View {
    GeometryReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Text("HARNESS")
            .font(.system(size: 11, weight: .semibold))
            .tracking(1.8)
            .foregroundStyle(HarnessColor.tertiary)

          Text("Connect this iPhone")
            .font(.system(size: 34, weight: .semibold))
            .tracking(-0.8)
            .padding(.top, 18)

          Text(
            "Scan the code from Harness on your Mac or headless machine. Your projects and credentials stay there."
          )
          .font(.system(size: 16))
          .foregroundStyle(HarnessColor.secondary)
          .lineSpacing(3)
          .padding(.top, 12)

          VStack(spacing: 0) {
            PairingActionRow(
              title: "Scan pairing code",
              icon: .qrCode,
              accent: HarnessColor.blue
            ) {
              scanning = true
            }

            Rectangle()
              .fill(HarnessColor.separator)
              .frame(height: 1)
              .padding(.leading, 62)

            PairingActionRow(
              title: "Paste pairing link",
              icon: .clipboardPaste,
              accent: .white.opacity(0.82)
            ) {
              link = UIPasteboard.general.string ?? ""
              if link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                withAnimation(.smooth(duration: 0.22)) { showingManualEntry = true }
              } else {
                Task { await pair() }
              }
            }
          }
          .harnessSurface()
          .padding(.top, 34)

          Button {
            withAnimation(.smooth(duration: 0.22)) {
              showingManualEntry.toggle()
            }
          } label: {
            HStack(spacing: 9) {
              LucideIconView(.link, size: 13)
              Text(showingManualEntry ? "Hide manual entry" : "Enter link manually")
                .font(.system(size: 14, weight: .medium))
              Spacer()
              LucideIconView(.chevronDown, size: 10)
                .rotationEffect(.degrees(showingManualEntry ? 180 : 0))
            }
            .foregroundStyle(HarnessColor.secondary)
            .padding(.horizontal, 4)
            .frame(height: 48)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)

          if showingManualEntry {
            HStack(spacing: 8) {
              TextField("harness://pair?payload=…", text: $link)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .font(.system(size: 13, design: .monospaced))
                .padding(.leading, 10)
                .onSubmit {
                  guard canConnect else { return }
                  Task { await pair() }
                }

              Button {
                Task { await pair() }
              } label: {
                LucideIconView(.arrowRight, size: 15)
                  .frame(width: 40, height: 40)
                  .glassEffect(.regular.interactive(), in: .circle)
                  .foregroundStyle(canConnect ? HarnessColor.primary : HarnessColor.tertiary)
              }
              .buttonStyle(.plain)
              .disabled(!canConnect)
              .accessibilityLabel("Connect using pairing link")
            }
            .padding(6)
            .frame(height: 54)
            .harnessSurface(cornerRadius: 17)
            .transition(.move(edge: .top).combined(with: .opacity))
          }

          if pairing {
            HStack(spacing: 9) {
              LucideLoader(size: 14)
                .foregroundStyle(.white)
              Text("Pairing securely…")
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(HarnessColor.secondary)
            .padding(.top, 15)
            .transition(.opacity)
          }

          Spacer(minLength: 44)

          LucideLabel("Pairing codes expire after five minutes.", icon: .lockKeyhole, iconSize: 13)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(HarnessColor.tertiary)
        }
        .frame(
          maxWidth: 520,
          minHeight: max(0, proxy.size.height - 68),
          alignment: .topLeading
        )
        .padding(.horizontal, 24)
        .padding(.top, 44)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity)
      }
      .scrollIndicators(.hidden)
      .scrollEdgeEffectHidden()
      .scrollDismissesKeyboard(.interactively)
    }
  }

  private var canConnect: Bool {
    !link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !pairing
  }

  private var scanner: some View {
    ZStack {
      QRScannerView { value in
        link = value
        scanning = false
        Task { await pair() }
      }
      .ignoresSafeArea()

      Color.black.opacity(0.28).ignoresSafeArea()
      RoundedRectangle(cornerRadius: 34)
        .stroke(.white.opacity(0.88), style: StrokeStyle(lineWidth: 3, dash: [45, 260]))
        .frame(width: 278, height: 278)
        .shadow(color: .black.opacity(0.35), radius: 20)

      VStack {
        HStack {
          GlassIconButton(icon: .x, accessibilityLabel: "Close scanner") {
            scanning = false
          }
          Spacer()
        }
        .padding(.horizontal, 22)
        .padding(.top, 10)
        Spacer()
        Text("Scan the code shown by Harness")
          .font(.headline)
          .padding(.horizontal, 20)
          .frame(height: 48)
          .glassEffect(.regular, in: .capsule)
          .padding(.bottom, 44)
      }
    }
  }

  private func pair() async {
    guard !pairing else { return }
    pairing = true
    defer { pairing = false }
    do {
      try await model.pair(using: link)
    } catch {
      localError = error.localizedDescription
    }
  }
}

private struct PairingActionRow: View {
  let title: String
  let icon: LucideIcon
  let accent: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 13) {
        HarnessIconBadge(icon: icon, tint: accent, size: 36, iconSize: 17)

        Text(title)
          .font(.system(size: 15, weight: .semibold))

        Spacer(minLength: 12)

        LucideIconView(.chevronRight, size: 10)
          .foregroundStyle(HarnessColor.tertiary)
      }
      .padding(.horizontal, 13)
      .frame(height: 62)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
  }
}

struct AddEnvironmentView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var link: String
  @State private var scanning = false
  @State private var pairing = false
  @State private var errorMessage: String?

  init(initialLink: String = "") {
    _link = State(initialValue: initialLink)
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 24) {
        SheetHeader(
          title: "Add environment",
          leading: AnyView(
            GlassIconButton(icon: .x, accessibilityLabel: "Close") { dismiss() })
        )
        Spacer()
        if scanning {
          ZStack {
            QRScannerView { value in
              link = value
              scanning = false
              Task { await pair() }
            }
            .clipShape(.rect(cornerRadius: 30))
            RoundedRectangle(cornerRadius: 24)
              .stroke(.white.opacity(0.85), style: StrokeStyle(lineWidth: 2, dash: [32, 180]))
              .frame(width: 224, height: 224)
          }
          .frame(height: 330)
          .padding(.horizontal, 22)
        } else {
          HarnessIconBadge(
            icon: .monitorSmartphone,
            tint: HarnessColor.primary,
            size: 54,
            iconSize: 25
          )
          Text("Pair another Harness machine")
            .font(.title2.bold())
          Text(
            "Create a five-minute pairing code with Harness on that machine, then scan or paste it here."
          )
          .foregroundStyle(HarnessColor.secondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 38)
        }
        Spacer()

        VStack(spacing: 12) {
          Button {
            scanning.toggle()
          } label: {
            LucideLabel(
              scanning ? "Enter link instead" : "Scan pairing code",
              icon: scanning ? .keyboard : .qrCode
            )
            .frame(maxWidth: .infinity, minHeight: 52)
          }
          .buttonStyle(.glassProminent)

          HStack(spacing: 10) {
            TextField("Paste pairing link", text: $link)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .font(.system(.footnote, design: .monospaced))
              .padding(.horizontal, 14)
              .frame(height: 50)
              .harnessSurface(cornerRadius: 17)
            GlassIconButton(
              icon: .clipboardPaste,
              accessibilityLabel: "Paste pairing link",
              size: 48,
              iconSize: 17
            ) {
              if let value = UIPasteboard.general.string { link = value }
            }
          }
          Button(pairing ? "Pairing…" : "Connect") { Task { await pair() } }
            .buttonStyle(.borderedProminent)
            .disabled(link.isEmpty || pairing)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
      }
      .background(HarnessColor.background)
      .toolbar(.hidden, for: .navigationBar)
    }
    .presentationDetents([.large])
    .alert(
      "Couldn’t pair",
      isPresented: Binding(
        get: { errorMessage != nil },
        set: { if !$0 { errorMessage = nil } }
      )
    ) {
      Button("OK", role: .cancel) { errorMessage = nil }
    } message: {
      Text(errorMessage ?? "")
    }
    .task {
      if !link.isEmpty { await pair() }
    }
  }

  private func pair() async {
    guard !pairing else { return }
    pairing = true
    defer { pairing = false }
    do {
      try await model.pair(using: link)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
