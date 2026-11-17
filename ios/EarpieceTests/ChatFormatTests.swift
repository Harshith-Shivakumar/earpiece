import Foundation
import Testing
@testable import Earpiece

struct ChatFormatTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func relativeTime() {
        #expect(ChatFormat.ago(now.addingTimeInterval(-20), now: now) == "just now")
        #expect(ChatFormat.ago(now.addingTimeInterval(5), now: now) == "just now")
        #expect(ChatFormat.ago(now.addingTimeInterval(-12 * 60), now: now) == "12 min ago")
        #expect(ChatFormat.ago(now.addingTimeInterval(-3 * 3600 - 100), now: now) == "3 hr ago")
        #expect(ChatFormat.ago(now.addingTimeInterval(-30 * 3600), now: now) == "yesterday")
        #expect(ChatFormat.ago(now.addingTimeInterval(-5 * 86400), now: now) == "5 days ago")
    }

    @Test func sourceLabels() {
        #expect(ChatFormat.sourceLabel("cli") == "Terminal")
        #expect(ChatFormat.sourceLabel("claude-desktop") == "Desktop")
        #expect(ChatFormat.sourceLabel("sdk-cli") == "SDK")
        #expect(ChatFormat.sourceLabel("something-new") == "something-new")
        #expect(ChatFormat.sourceLabel("") == "")
    }

    @Test func subtitleSkipsMissingParts() {
        let full = ChatItem(id: "a", title: "T", cwd: "/x/uploader", folder: "uploader", source: "cli",
                            updatedAt: now.addingTimeInterval(-12 * 60))
        #expect(ChatFormat.subtitle(for: full, now: now) == "uploader · 12 min ago · Terminal")
        let bare = ChatItem(id: "b", title: "T")
        #expect(ChatFormat.subtitle(for: bare, now: now) == "")
        let noTime = ChatItem(id: "c", title: "T", folder: "site", source: "claude-desktop")
        #expect(ChatFormat.subtitle(for: noTime, now: now) == "site · Desktop")
    }
}
