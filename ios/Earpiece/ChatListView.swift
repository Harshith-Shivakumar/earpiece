import SwiftUI

/// The chat picker (SPEC 10.5): "New chat" first, then recent Claude Code chats from the bridge.
/// Used as the main screen's content before a drive and in a sheet during one.
struct ChatListView: View {
    @ObservedObject var drive: DriveController
    /// Called after a pick (the sheet closes itself).
    var onPick: (() -> Void)? = nil

    var body: some View {
        List {
            if let ended = drive.deskCard, !drive.isLive {
                Section {
                    DeskCardView(ended: ended) { drive.dismissDeskCard() }
                }
            }
            Section {
                Button {
                    drive.pickNewChat()
                    onPick?()
                } label: {
                    Label("New chat", systemImage: "plus.bubble.fill")
                        .font(.title3.weight(.semibold))
                        .padding(.vertical, 6)
                }
                .accessibilityHint("Starts a new Claude Code chat")
            }

            Section {
                if drive.chats.isEmpty {
                    Text(emptyText)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                }
                ForEach(drive.chats) { chat in
                    Button {
                        drive.pick(chat)
                        onPick?()
                    } label: {
                        ChatRow(chat: chat, isCurrent: chat.current || chat.id == drive.currentChat?.id)
                    }
                    .foregroundStyle(.primary)
                }
            } header: {
                HStack {
                    Text("Recent chats")
                    if drive.isRefreshingChats {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await drive.refreshChatsAndWait() }
        .onAppear { drive.refreshChats() }
    }

    private var emptyText: String {
        switch drive.link {
        case .connected: return drive.isRefreshingChats ? "Loading chats…" : "No chats from the last 30 days."
        case .connecting: return "Connecting to the bridge…"
        default:
            if drive.connections.selected == nil { return "Add a connection: scan the QR code the bridge prints." }
            return drive.connectionProblem.map { "\($0) Pull to retry." } ?? "Not connected to the bridge. Pull to retry."
        }
    }
}

struct ChatRow: View {
    let chat: ChatItem
    let isCurrent: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(chat.title)
                    .font(.title3.weight(.semibold))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                let subtitle = ChatFormat.subtitle(for: chat)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if chat.recentlyActive {
                    Text("Active recently")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.2), in: Capsule())
                        .foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 0)
            if isCurrent {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.green)
                    .accessibilityLabel("Current chat")
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
