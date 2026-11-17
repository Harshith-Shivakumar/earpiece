import SwiftUI

/// Main screen. Top: the selected connection (picker). Before a drive: the big Start button and the
/// chat list (tap a chat to start the drive in it), with the Continue at your desk card after a drive.
/// During a drive: the current chat, the big End drive button, a Chats button, the last spoken line
/// and a short log. Large text so it reads at a glance when parked; nothing is needed while driving.
struct ContentView: View {
    @ObservedObject var drive: DriveController
    @ObservedObject var store: ConnectionStore
    @State private var showSettings = false
    @State private var showChats = false
    @State private var showLog = false
    @State private var showConnections = false
    @State private var confirmEndDrive = false

    init(drive: DriveController) {
        self.drive = drive
        self.store = drive.connections
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                connectionPicker
                    .padding(.horizontal)
                statusRow
                    .padding(.horizontal)
                if drive.isLive {
                    driveContent
                        .padding(.horizontal)
                } else {
                    startButton
                        .padding(.horizontal)
                    ChatListView(drive: drive)
                }
            }
            .padding(.top, 4)
            .navigationTitle("Earpiece")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !drive.isLive {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Log") { showLog = true }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showSettings, onDismiss: { drive.connectionsDidChange() }) {
                SettingsView(settings: drive.settings, drive: drive)
            }
            .sheet(isPresented: $showConnections, onDismiss: { drive.connectionsDidChange() }) {
                NavigationStack {
                    ConnectionsView(drive: drive, store: store)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { showConnections = false }
                            }
                        }
                }
            }
            .sheet(item: $drive.pendingPairing) { info in
                PairingConfirmView(
                    info: info,
                    alreadySaved: store.connection(id: info.id) != nil,
                    onAdd: { drive.confirmPairing(info) },
                    onCancel: { drive.pendingPairing = nil })
            }
            .alert("End drive?", isPresented: $confirmEndDrive) {
                Button("End drive", role: .destructive) { drive.endDrive() }
                Button("Keep driving", role: .cancel) {}
            } message: {
                Text(endDriveMessage)
            }
            .alert("Claude is still working. Stop it and end the drive?", isPresented: $drive.showEndDriveBusy) {
                Button("Stop and end", role: .destructive) { drive.endDrive(force: true) }
                Button("Keep driving", role: .cancel) { drive.keepDriving() }
            }
            .sheet(isPresented: $showChats) {
                NavigationStack {
                    ChatListView(drive: drive) { showChats = false }
                        .navigationTitle("Chats")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { showChats = false }
                            }
                        }
                }
            }
            .sheet(isPresented: $showLog) {
                NavigationStack {
                    logView
                        .padding()
                        .navigationTitle("Log")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { showLog = false }
                            }
                        }
                }
            }
            .alert("Earpiece", isPresented: alertBinding) {
                Button("OK", role: .cancel) { drive.alert = nil }
            } message: {
                Text(drive.alert ?? "")
            }
            .task { drive.appDidBecomeActive() }
        }
    }

    // MARK: During a drive

    private var driveContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            currentChatCard
            HStack(spacing: 12) {
                endDriveButton
                Button {
                    showChats = true
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: "list.bullet")
                            .font(.title)
                        Text("Chats")
                            .font(.headline)
                    }
                    .frame(width: 96, height: 96)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Show chats")
            }
            if drive.isPaused {
                Label("Paused. Say \u{201C}I'm back\u{201D} to resume.", systemImage: "pause.circle.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.orange)
            }
            lastSpokenCard
            if !drive.liveTranscript.isEmpty {
                Text("You: \(drive.liveTranscript)")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            logView
        }
    }

    private var currentChatCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(drive.currentChat?.title ?? "No chat yet")
                .font(.title2.weight(.bold))
                .lineLimit(2)
            Text(drive.currentChat == nil
                 ? "Say a task to start a new chat, or tap Chats."
                 : DriveController.basename(drive.cwd))
                .font(.headline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var lastSpokenCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Last spoken")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(drive.lastSpoken.isEmpty ? "Nothing yet" : drive.lastSpoken)
                .font(.title3)
                .lineLimit(5)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: Connection picker (SPEC 11.4)

    private var connectionPicker: some View {
        Menu {
            ForEach(store.connections) { saved in
                Button {
                    drive.selectConnection(saved.id)
                } label: {
                    if saved.id == store.selectedID {
                        Label(saved.name, systemImage: "checkmark")
                    } else {
                        Text(saved.name)
                    }
                }
            }
            Divider()
            Button {
                showConnections = true
            } label: {
                Label("Add connection", systemImage: "plus")
            }
            if !store.connections.isEmpty {
                Button {
                    showConnections = true
                } label: {
                    Label("Manage connections", systemImage: "list.bullet")
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "desktopcomputer")
                Text(store.selected?.name ?? "Add a connection")
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                if !drive.isLive {
                    Image(systemName: "chevron.down")
                        .font(.subheadline.weight(.semibold))
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(.primary)
        }
        .disabled(drive.isLive)  // switching is only allowed without a live drive
        .accessibilityLabel("Connection: \(store.selected?.name ?? "none")")
    }

    // MARK: End drive (SPEC 11.5)

    /// The exact confirmation copy from SPEC 11.5.
    private var endDriveMessage: String {
        guard let chat = drive.currentChat else { return "Ends the drive and saves the summary." }
        return "Claude switches voice mode off for \(chat.title). Continue it at your desk in a terminal: claude -c in \(DriveController.basename(drive.cwd))."
    }

    private var endDriveButton: some View {
        Button {
            confirmEndDrive = true
        } label: {
            VStack(spacing: 4) {
                if drive.isEndingDrive {
                    HStack(spacing: 10) {
                        ProgressView().tint(.white)
                        Text("Ending drive…")
                            .font(.system(size: 30, weight: .bold, design: .rounded))
                    }
                    Text("Handing the chat back to your desk")
                        .font(.subheadline.weight(.medium))
                } else {
                    Text("End drive")
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                    Text("Hands the chat back to your desk")
                        .font(.subheadline.weight(.medium))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 96)
        }
        .buttonStyle(.borderedProminent)
        .tint(.red)
        .disabled(drive.isEndingDrive)
        .accessibilityLabel("End drive")
        .accessibilityHint("Hands the chat back to your desk")
    }

    // MARK: Shared pieces

    private var alertBinding: Binding<Bool> {
        Binding(get: { drive.alert != nil }, set: { if !$0 { drive.alert = nil } })
    }

    private var statusRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Circle()
                    .fill(linkColor)
                    .frame(width: 14, height: 14)
                Text(linkText)
                    .font(.headline)
                Spacer()
                if drive.link == .connected {
                    Text(drive.bridgeState.label)
                        .font(.headline)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(stateColor.opacity(0.2), in: Capsule())
                        .foregroundStyle(stateColor)
                }
            }
            if let problem = drive.connectionProblem, drive.link != .connected {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.orange)
            }
            if drive.isLive, !drive.audioRoute.isEmpty {
                Label(drive.audioRoute, systemImage: "speaker.wave.2")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private var startButton: some View {
        Button {
            drive.start()
        } label: {
            HStack {
                if drive.isStarting {
                    ProgressView().tint(.white)
                }
                Text("Start")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
            }
            .frame(maxWidth: .infinity, minHeight: 96)
        }
        .buttonStyle(.borderedProminent)
        .tint(.green)
        .disabled(drive.isStarting)
        .accessibilityLabel("Start drive")
    }

    private var logView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(drive.log) { line in
                        Text("\(line.time.formatted(date: .omitted, time: .standard))  \(line.text)")
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(line.id)
                    }
                }
            }
            .onAppear {
                if let last = drive.log.last?.id { proxy.scrollTo(last, anchor: .bottom) }
            }
            .onChange(of: drive.log.last?.id) { _, newID in
                if let newID { withAnimation { proxy.scrollTo(newID, anchor: .bottom) } }
            }
        }
        .frame(maxHeight: .infinity)
    }

    private var linkColor: Color {
        switch drive.link {
        case .connected: return .green
        case .connecting: return .yellow
        case .retrying, .bridgeOffline: return .orange
        case .offline: return .gray
        }
    }

    /// "Connected · via relay" / "Connected · direct".
    private var linkText: String {
        guard drive.link == .connected, let path = drive.linkPath else { return drive.link.label }
        return "\(drive.link.label) · \(path.label)"
    }

    private var stateColor: Color {
        switch drive.bridgeState {
        case .idle: return .gray
        case .holding: return .yellow
        case .working: return .blue
        case .waitingForYou: return .orange
        case .other: return .gray
        }
    }
}

#Preview {
    ContentView(drive: DriveController.shared)
}
