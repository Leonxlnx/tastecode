import Foundation

enum HarnessFormat {
  static func projectLabel(_ path: String) -> String {
    let normalized = path.replacingOccurrences(of: "\\", with: "/")
    let pieces = normalized.split(separator: "/").map(String.init)
    guard pieces.count > 1 else { return pieces.last ?? path }
    return pieces.suffix(2).joined(separator: "/")
  }

  static func projectName(_ path: String) -> String {
    path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init)
      ?? path
  }

  static func relativeTime(from milliseconds: Double, now: Date = .now) -> String {
    let date = Date(timeIntervalSince1970: milliseconds / 1_000)
    let seconds = max(0, now.timeIntervalSince(date))
    if seconds < 60 { return "now" }
    if seconds < 3_600 { return "\(Int(seconds / 60))m" }
    if seconds < 86_400 { return "\(Int(seconds / 3_600))h" }
    if seconds < 604_800 { return "\(Int(seconds / 86_400))d" }
    return date.formatted(.dateTime.month(.abbreviated).day())
  }

  static func clockTime(from milliseconds: Double) -> String {
    Date(timeIntervalSince1970: milliseconds / 1_000).formatted(date: .omitted, time: .shortened)
  }

  static func elapsed(milliseconds: Double) -> String {
    let total = max(0, Int(milliseconds / 1_000))
    let hours = total / 3_600
    let minutes = (total % 3_600) / 60
    let seconds = total % 60
    if hours > 0 { return "\(hours)h \(minutes)m" }
    if minutes > 0 { return "\(minutes)m \(seconds)s" }
    return "\(seconds)s"
  }

  static func taskTitle(_ prompt: String) -> String {
    let collapsed = prompt.split(whereSeparator: \Character.isWhitespace).joined(separator: " ")
    guard collapsed.count > 72 else { return collapsed }
    return String(collapsed.prefix(69)).trimmingCharacters(in: .whitespaces) + "…"
  }

  static func label(for effort: String) -> String {
    switch effort.lowercased() {
    case "low": "Low"
    case "medium": "Medium"
    case "high": "High"
    case "xhigh", "extra-high", "extra_high": "Extra High"
    case "max": "Max"
    case "ultra": "Ultra"
    default: effort.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }
}
