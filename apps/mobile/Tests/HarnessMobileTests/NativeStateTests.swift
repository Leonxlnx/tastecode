import Foundation
import UIKit
import XCTest

@testable import HarnessMobile

final class NativeStateTests: XCTestCase {
  func testPairingParserAcceptsPrivateRoutesAndRemovesTerminalWrapping() throws {
    let expiresAt = Date.now.timeIntervalSince1970 * 1_000 + 60_000
    let payload = JSONValue.object([
      "version": .number(1),
      "serverName": .string("Studio Mac"),
      "ticket": .string(String(repeating: "a", count: 43)),
      "expiresAt": .number(expiresAt),
      "endpoints": .array([
        .string("ws://100.101.2.3:4312/"),
        .string("ws://192.168.1.20:4312/"),
        .string("ws://8.8.8.8:4312/"),
      ]),
    ])
    let data = try JSONEncoder().encode(payload)
    let encoded = data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    let wrapped = "  harness://pair?pay\nload=\(encoded)\u{200B}  "

    let offer = try PairingParser.parse(wrapped)

    XCTAssertEqual(offer.serverName, "Studio Mac")
    XCTAssertEqual(offer.endpoints, ["ws://100.101.2.3:4312/", "ws://192.168.1.20:4312/"])
  }

  func testPairingParserRejectsExpiredOffer() throws {
    let payload = JSONValue.object([
      "version": .number(1),
      "serverName": .string("Mac"),
      "ticket": .string(String(repeating: "b", count: 43)),
      "expiresAt": .number(1),
      "endpoints": .array([.string("ws://10.0.0.2:4312/")]),
    ])
    let data = try JSONEncoder().encode(payload)
    let encoded = data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")

    XCTAssertThrowsError(try PairingParser.parse("harness://pair?payload=\(encoded)"))
  }

  func testPairingClaimIgnoresWelcomeBeforeClaimResponse() throws {
    let offer = PairingOffer(
      serverName: "Studio Mac",
      ticket: String(repeating: "c", count: 43),
      expiresAt: Date.now.timeIntervalSince1970 * 1_000 + 60_000,
      endpoints: ["ws://100.101.2.3:4312/"]
    )
    let welcome = Data(#"{"channel":"server.welcome","sequence":1,"data":{}}"#.utf8)
    XCTAssertNil(
      try PairingClient.claimedEnvironment(
        from: welcome,
        offer: offer,
        endpoint: offer.endpoints[0]
      ))

    let response = Data(
      #"{"id":"claim","result":{"deviceId":"phone-1","deviceToken":"secret-token","serverName":"Studio Mac","addresses":[{"url":"ws://100.101.2.3:4312/"}]}}"#
        .utf8)
    let environment = try PairingClient.claimedEnvironment(
      from: response,
      offer: offer,
      endpoint: offer.endpoints[0]
    )
    XCTAssertEqual(environment?.deviceId, "phone-1")
    XCTAssertEqual(environment?.preferredEndpoint, offer.endpoints[0])
  }

  func testProviderResponseDecodesEveryContractProvider() throws {
    let data = Data(
      #"""
      {"providers":[
        {"id":"codex","displayName":"Codex","installed":true,"auth":"authenticated"},
        {"id":"claude-code","displayName":"Claude Code","installed":true,"auth":"authenticated"},
        {"id":"grok","displayName":"Grok","installed":false,"auth":"unknown"},
        {"id":"cursor","displayName":"Cursor","installed":false,"auth":"unknown"},
        {"id":"opencode","displayName":"OpenCode","installed":true,"auth":"unknown"},
        {"id":"antigravity","displayName":"Antigravity","installed":false,"auth":"unknown"},
        {"id":"acp","displayName":"ACP agents","installed":true,"auth":"unknown"},
        {"id":"api","displayName":"API","installed":true,"auth":"authenticated"}
      ]}
      """#.utf8
    )

    let response = try JSONDecoder().decode(ProvidersResponse.self, from: data)

    XCTAssertEqual(response.providers.map(\.id), ProviderID.allCases)
  }

  func testPreferencesDecodeMissingFieldsAndDropsLegacySettings() throws {
    let preferences = try JSONDecoder().decode(
      AppPreferences.self,
      from: Data(
        #"{"reconnectAutomatically":false,"projectGrouping":false,"composer":{"provider":"acp"}}"#
          .utf8)
    )

    XCTAssertEqual(preferences.composer.provider, .acp)
    XCTAssertEqual(preferences.composer.approval, .full)
    XCTAssertFalse(preferences.composer.designMode)
    XCTAssertNil(preferences.composer.agentID)
    XCTAssertNil(preferences.lastProjectPath)

    let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(preferences))
    let object = try XCTUnwrap(encoded as? [String: Any])
    XCTAssertNil(object["reconnectAutomatically"])
    XCTAssertNil(object["projectGrouping"])
  }

  func testPreferencesPersistLastProjectAndDesignMode() throws {
    let preferences = AppPreferences(
      lastProjectPath: "/repo",
      composer: ComposerPreferences(designMode: true)
    )

    let restored = try JSONDecoder().decode(
      AppPreferences.self,
      from: JSONEncoder().encode(preferences)
    )

    XCTAssertEqual(restored.lastProjectPath, "/repo")
    XCTAssertTrue(restored.composer.designMode)
  }

  func testProjectSelectionUsesRememberedProjectThenRecentProject() throws {
    let olderThread = ThreadSummary(
      id: "older",
      title: "Older",
      provider: .codex,
      agent: nil,
      createdAt: 1_000,
      running: false,
      status: nil,
      unread: false,
      lifecycle: nil,
      closedAt: nil,
      worktreeBranch: nil
    )
    let newerThread = ThreadSummary(
      id: "newer",
      title: "Newer",
      provider: .codex,
      agent: nil,
      createdAt: 2_000,
      running: false,
      status: nil,
      unread: false,
      lifecycle: nil,
      closedAt: nil,
      worktreeBranch: nil
    )
    let older = ProjectRecord(
      path: "/older", name: "Older", pinned: false, createdAt: 1, sessions: [olderThread])
    let newer = ProjectRecord(
      path: "/newer", name: "Newer", pinned: false, createdAt: 2, sessions: [newerThread])

    XCTAssertEqual(
      ProjectSelection.resolve(preferredPath: "/older", projects: [older, newer])?.path,
      "/older"
    )
    XCTAssertEqual(
      ProjectSelection.resolve(preferredPath: nil, projects: [older, newer])?.path,
      "/newer"
    )
    XCTAssertNil(
      ProjectSelection.resolve(
        preferredPath: nil,
        projects: [
          ProjectRecord(
            path: "/one", name: "One", pinned: false, createdAt: 1, sessions: []),
          ProjectRecord(
            path: "/two", name: "Two", pinned: false, createdAt: 2, sessions: []),
        ]
      ))
  }

  func testComposerSubmissionAddsDesignBriefAndPlanInstruction() {
    XCTAssertEqual(
      ComposerSubmission.attachments(["reference.png"], designMode: true),
      ["reference.png", ComposerSubmission.designBriefAttachment]
    )
    XCTAssertEqual(
      ComposerSubmission.attachments(
        [ComposerSubmission.designBriefAttachment], designMode: true),
      [ComposerSubmission.designBriefAttachment]
    )
    XCTAssertEqual(
      ComposerSubmission.text("Build it", interaction: .plan),
      "Plan this task first. Do not make changes until I approve the plan.\n\nBuild it"
    )
  }

  func testEnvironmentAppearanceDefaultsAndRoundTrips() throws {
    let legacy = Data(
      #"{"deviceId":"device-1","deviceToken":"test-token","serverName":"Studio Mac","endpoints":["ws://10.0.0.2:4312/"],"preferredEndpoint":null}"#
        .utf8
    )
    var environment = try JSONDecoder().decode(PairedEnvironment.self, from: legacy)

    XCTAssertEqual(environment.displayName, "Studio Mac")
    XCTAssertEqual(environment.displayIcon, .desktop)
    XCTAssertEqual(environment.displayAccent, .blue)

    environment.customName = "  Home Studio  "
    environment.icon = .server
    environment.accent = .purple
    let restored = try JSONDecoder().decode(
      PairedEnvironment.self,
      from: JSONEncoder().encode(environment)
    )

    XCTAssertEqual(restored.displayName, "Home Studio")
    XCTAssertEqual(restored.displayIcon, .server)
    XCTAssertEqual(restored.displayAccent, .purple)
  }

  func testComposerMenuSelectionUpdatesDependentSettingsTogether() {
    let option = ModelOption(
      id: "claude-sonnet",
      displayName: "Sonnet",
      isDefault: true,
      reasoningEfforts: ["medium", "high"],
      defaultReasoningEffort: "medium",
      serviceTiers: [ServiceTier(id: "standard", name: "Standard", description: "")],
      defaultServiceTier: "standard"
    )
    var preferences = ComposerPreferences(
      provider: .codex,
      agentID: "stale-agent",
      modelID: "stale-model",
      effort: "high",
      serviceTier: "priority",
      approval: .autoReview
    )

    ComposerMenuSelection.apply(
      provider: .claudeCode,
      model: option,
      installedACPAgentID: "installed-agent",
      supportsAutoReview: false,
      to: &preferences
    )

    XCTAssertEqual(preferences.provider, .claudeCode)
    XCTAssertNil(preferences.agentID)
    XCTAssertEqual(preferences.modelID, option.id)
    XCTAssertEqual(preferences.effort, "medium")
    XCTAssertEqual(preferences.serviceTier, "standard")
    XCTAssertEqual(preferences.approval, .auto)
  }

  func testTimelineAppliesStreamingItemAndResolution() {
    var timeline = ThreadTimeline()
    timeline.apply(
      event: .object([
        "type": .string("turn.started"),
        "turn": .object([
          "id": .string("turn-1"),
          "threadId": .string("thread-1"),
          "status": .string("running"),
          "createdAt": .number(1_000),
        ]),
      ]))
    timeline.apply(
      event: .object([
        "type": .string("item.started"),
        "item": .object([
          "id": .string("item-1"),
          "turnId": .string("turn-1"),
          "type": .string("message"),
          "status": .string("started"),
          "role": .string("assistant"),
          "text": .string("Hello"),
          "createdAt": .number(1_100),
        ]),
      ]))
    timeline.apply(
      event: .object([
        "type": .string("item.delta"),
        "turnId": .string("turn-1"),
        "itemId": .string("item-1"),
        "textDelta": .string(" world"),
      ]))
    timeline.apply(
      event: .object([
        "type": .string("turn.completed"),
        "turnId": .string("turn-1"),
        "status": .string("completed"),
      ]))

    XCTAssertEqual(timeline.turns.first?.items.first?.text, "Hello world")
    XCTAssertEqual(timeline.turns.first?.status, "completed")
    XCTAssertFalse(timeline.running)
  }

  func testTimelineDeltaBufferCoalescesTextPerItem() {
    var buffer = TimelineDeltaBuffer()
    let first = JSONValue.object([
      "type": .string("item.delta"),
      "turnId": .string("turn-1"),
      "itemId": .string("item-1"),
      "textDelta": .string("Hello"),
    ])
    let second = JSONValue.object([
      "type": .string("item.delta"),
      "turnId": .string("turn-1"),
      "itemId": .string("item-1"),
      "textDelta": .string(" world"),
    ])

    XCTAssertTrue(buffer.append(event: first))
    XCTAssertTrue(buffer.append(event: second))
    XCTAssertEqual(
      buffer.drain(),
      [TimelineTextDelta(turnID: "turn-1", itemID: "item-1", text: "Hello world")]
    )
    XCTAssertTrue(buffer.isEmpty)
  }

  func testTranscriptPresentationKeepsCommentaryInWorkAndOneFinalAnswer() throws {
    let user = try timelineItem(
      id: "user", type: "message", role: "user", text: "Fix the transcript", createdAt: 1_000)
    let commentary = try timelineItem(
      id: "commentary", type: "message", role: "assistant", text: "I’ll trace it.",
      createdAt: 2_000)
    let command = try timelineItem(
      id: "command", type: "command", text: "tests passed", command: "pnpm test",
      createdAt: 3_000)
    let answer = try timelineItem(
      id: "answer", type: "message", role: "assistant", text: "Fixed.", createdAt: 5_000)
    let turn = TimelineTurn(
      id: "turn-1",
      createdAt: 1_000,
      status: "completed",
      items: [user, commentary, command, answer]
    )

    let presentation = TimelineTranscriptPresentation.present(turn)

    XCTAssertEqual(presentation.userMessages.map(\.id), ["user"])
    XCTAssertEqual(presentation.workItems.map(\.id), ["commentary", "command"])
    XCTAssertEqual(presentation.finalAnswer?.id, "answer")
    XCTAssertEqual(presentation.elapsedMs, 4_000)
    XCTAssertTrue(presentation.complete)
  }

  func testTranscriptWorkBlocksKeepToolCallsTogetherAcrossBlankNarrative() throws {
    let first = try timelineItem(id: "tool-1", type: "tool_call", text: "read file")
    let blank = try timelineItem(
      id: "blank", type: "message", role: "assistant", text: "  ", createdAt: 2_000)
    let second = try timelineItem(
      id: "tool-2", type: "command", text: "ok", command: "pnpm test", createdAt: 3_000)

    let blocks = TimelineTranscriptPresentation.workBlocks(from: [first, blank, second])

    XCTAssertEqual(blocks, [.toolCalls([first, second])])
  }

  func testTranscriptPresentationDoesNotCompactWhileWorkIsStarted() throws {
    let startedTool = try timelineItem(
      id: "tool", type: "tool_call", status: "started", text: "searching")
    let answer = try timelineItem(
      id: "answer", type: "message", role: "assistant", text: "Draft answer",
      createdAt: 2_000)
    let turn = TimelineTurn(
      id: "turn-1",
      createdAt: 1_000,
      status: "running",
      items: [startedTool, answer]
    )

    let presentation = TimelineTranscriptPresentation.present(turn)

    XCTAssertEqual(presentation.finalAnswer?.id, "answer")
    XCTAssertFalse(presentation.complete)
  }

  func testProjectFormattingHandlesUnixAndWindowsPaths() {
    XCTAssertEqual(
      HarnessFormat.projectLabel("/Users/blueemi/Developer/harness"), "Developer/harness")
    XCTAssertEqual(HarnessFormat.projectLabel("C:\\Users\\Leon\\harness"), "Leon/harness")
    XCTAssertEqual(HarnessFormat.taskTitle(String(repeating: "a", count: 100)).count, 70)
  }

  func testProjectDirectoryPresentationFiltersAndSortsCurrentFolder() {
    let entries = [
      ProjectDirectoryEntry(
        path: "/home/Developer", name: "Developer", kind: .directory, modifiedAt: 1),
      ProjectDirectoryEntry(
        path: "/home/notes.txt", name: "notes.txt", kind: .file, modifiedAt: 2),
      ProjectDirectoryEntry(
        path: "/home/App.swift", name: "App.swift", kind: .file, modifiedAt: 3),
    ]

    XCTAssertEqual(
      ProjectDirectoryPresentation.entries(from: entries, query: "APP", sort: .name).map(\.name),
      ["App.swift"]
    )
    XCTAssertEqual(
      ProjectDirectoryPresentation.entries(from: entries, query: "", sort: .name).map(\.name),
      ["Developer", "App.swift", "notes.txt"]
    )
    XCTAssertEqual(
      ProjectDirectoryPresentation.entries(from: entries, query: "", sort: .modified).map(
        \.name),
      ["Developer", "App.swift", "notes.txt"]
    )
    XCTAssertEqual(
      ProjectDirectoryPresentation.entries(from: entries, query: "", sort: .kind).map(\.name),
      ["Developer", "App.swift", "notes.txt"]
    )
  }

  func testThreadRowsMoveBetweenActiveAndSettledShelves() throws {
    let settled = ThreadLifecycle(
      state: .settled,
      keepActive: nil,
      wokeAt: nil,
      settledAt: 1_000,
      reason: "manual",
      snoozedAt: nil,
      wakeAt: nil
    )
    let active = ThreadLifecycle(
      state: .active,
      keepActive: false,
      wokeAt: 2_000,
      settledAt: nil,
      reason: nil,
      snoozedAt: nil,
      wakeAt: nil
    )
    let thread = ThreadSummary(
      id: "thread-1",
      title: "Keep the row fresh",
      provider: .codex,
      agent: nil,
      createdAt: 500,
      running: false,
      status: "idle",
      unread: false,
      lifecycle: active,
      closedAt: nil,
      worktreeBranch: nil
    )
    let project = ProjectRecord(
      path: "/repo",
      name: "Repo",
      pinned: false,
      createdAt: 100,
      sessions: [thread]
    )

    let activeThread = try XCTUnwrap(project.sessions.first)
    let activeRow = ThreadRow(project: project, thread: activeThread)
    let activeSections = ThreadSections.partition([activeRow])
    XCTAssertEqual(activeSections.active.map(\.thread.id), [thread.id])
    XCTAssertTrue(activeSections.settled.isEmpty)

    let settledProjects = ProjectThreadState.applying(settled, to: thread.id, in: [project])
    let settledProject = try XCTUnwrap(settledProjects.first)
    let settledThread = try XCTUnwrap(settledProject.sessions.first)
    let settledRow = ThreadRow(project: settledProject, thread: settledThread)
    let settledSections = ThreadSections.partition([settledRow])
    XCTAssertTrue(settledSections.active.isEmpty)
    XCTAssertEqual(settledSections.settled.map(\.thread.id), [thread.id])
    XCTAssertNotEqual(activeRow.id, settledRow.id)

    let restored = ProjectThreadState.applying(active, to: thread.id, in: settledProjects)
    XCTAssertEqual(ProjectThreadState.lifecycleState(for: thread.id, in: restored), .active)
    XCTAssertEqual(restored.first?.sessions.first?.lifecycle, active)
  }

  func testLifecycleActionsProjectAndDecodeTheirAuthoritativeStates() throws {
    XCTAssertEqual(ThreadLifecycleAction.settle.method, "thread.settle")
    XCTAssertEqual(ThreadLifecycleAction.settle.projectedLifecycle(at: 1_000).state, .settled)
    XCTAssertEqual(ThreadLifecycleAction.unsettle.method, "thread.unsettle")
    XCTAssertEqual(ThreadLifecycleAction.unsettle.projectedLifecycle(at: 2_000).state, .active)

    let response: ThreadLifecycleResponse = try JSONValue.object([
      "lifecycle": .object([
        "state": .string("settled"),
        "settledAt": .number(3_000),
        "reason": .string("manual"),
      ])
    ]).decoded()

    XCTAssertEqual(response.lifecycle.state, .settled)
    XCTAssertEqual(response.lifecycle.settledAt, 3_000)
  }

  func testMobileSourceDoesNotUseSFSymbolAPIs() throws {
    let mobileRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let sourceRoot = mobileRoot.appendingPathComponent("Sources/HarnessMobile")
    let sourceFiles = try XCTUnwrap(
      FileManager.default.enumerator(
        at: sourceRoot,
        includingPropertiesForKeys: nil
      )?.allObjects as? [URL]
    ).filter { $0.pathExtension == "swift" }
    let forbidden = [
      "Image(" + "systemName:",
      "UIImage(" + "systemName:",
      "system" + "Image:",
      ".symbol" + "Effect(",
      ".symbol" + "RenderingMode(",
    ]

    for file in sourceFiles {
      let source = try String(contentsOf: file, encoding: .utf8)
      for pattern in forbidden {
        XCTAssertFalse(
          source.contains(pattern),
          "\(file.lastPathComponent) uses the forbidden SF Symbols API \(pattern)"
        )
      }
    }
  }

  func testEveryGeneratedIconAssetLoads() {
    for icon in LucideIcon.allCases {
      guard let image = UIImage(named: icon.assetName) else {
        XCTFail("Missing generated asset \(icon.assetName)")
        continue
      }
      XCTAssertEqual(image.size.width, 18, accuracy: 0.01)
      XCTAssertEqual(image.size.height, 18, accuracy: 0.01)
    }
    for assetName in [
      "OpenAIBlossom",
      "ProviderAnthropic",
      "ProviderAntigravity",
      "ProviderAcp",
      "ProviderCursor",
      "ProviderCustom",
      "ProviderGemini",
      "ProviderGrok",
      "ProviderKimi",
      "ProviderKimiAccent",
      "ProviderOpencode",
      "ProviderQwen",
    ] {
      XCTAssertNotNil(UIImage(named: assetName), "Missing provider asset \(assetName)")
    }
  }

  func testIconMetricsPreserveRequestedSize() {
    XCTAssertEqual(HarnessIconMetrics.renderedSize(16), 16)
  }

  private func timelineItem(
    id: String,
    type: String,
    status: String = "completed",
    role: String? = nil,
    text: String = "",
    command: String? = nil,
    path: String? = nil,
    createdAt: Double = 1_000
  ) throws -> TimelineItem {
    try XCTUnwrap(
      TimelineItem(
        json: .object(
          ("id", .string(id)),
          ("turnId", .string("turn-1")),
          ("type", .string(type)),
          ("status", .string(status)),
          ("role", .string(role)),
          ("text", .string(text)),
          ("command", .string(command)),
          ("path", .string(path)),
          ("createdAt", .number(createdAt))
        ))
    )
  }
}
