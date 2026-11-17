import Foundation

/// Text for chat rows: "folder · 12 min ago · Terminal".
enum ChatFormat {
    static func ago(_ date: Date, now: Date = Date()) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) hr ago" }
        if hours < 48 { return "yesterday" }
        return "\(hours / 24) days ago"
    }

    /// Friendlier names for Claude Code entrypoints; anything unknown is shown as-is.
    static func sourceLabel(_ source: String) -> String {
        switch source.lowercased() {
        case "cli": return "Terminal"
        case "claude-desktop": return "Desktop"
        case "claude-vscode": return "VS Code"
        case "sdk-cli", "sdk-ts", "sdk-py": return "SDK"
        default: return source
        }
    }

    static func subtitle(for chat: ChatItem, now: Date = Date()) -> String {
        var parts: [String] = []
        if !chat.folder.isEmpty { parts.append(chat.folder) }
        if let updated = chat.updatedAt { parts.append(ago(updated, now: now)) }
        let source = sourceLabel(chat.source)
        if !source.isEmpty { parts.append(source) }
        return parts.joined(separator: " · ")
    }
}
