import SwiftUI
import UIKit

/// SPEC 11.5 "Continue at your desk": after the drive, how to pick each chat up in a terminal.
struct DeskCardView: View {
    let ended: DriveEnded
    let onDismiss: () -> Void
    @State private var copiedID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Label("Continue at your desk", systemImage: "desktopcomputer")
                    .font(.title3.weight(.bold))
                Spacer()
                Button {
                    onDismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
            if ended.chats.isEmpty {
                Text("The drive has ended. No chat was open; the summary is on the server.")
                    .font(.body)
                    .foregroundStyle(.secondary)
            } else {
                Text("The drive has ended and voice mode is off. Paste this in a terminal on your Mac to carry on with the chat.")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            ForEach(ended.chats) { chat in
                VStack(alignment: .leading, spacing: 6) {
                    Text(chat.title)
                        .font(.headline)
                        .lineLimit(2)
                    if !chat.folder.isEmpty {
                        Label(chat.folder, systemImage: "folder")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    HStack(alignment: .center, spacing: 10) {
                        Text(chat.resumeCmd)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button {
                            UIPasteboard.general.string = chat.resumeCmd
                            copiedID = chat.id
                        } label: {
                            Text(copiedID == chat.id ? "Copied" : "Copy")
                                .font(.headline)
                                .frame(minWidth: 64)
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityLabel("Copy the command for \(chat.title)")
                    }
                    .padding(10)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                    if !chat.folder.isEmpty {
                        Text("or run claude -c in \(chat.folder)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(.vertical, 6)
    }
}
