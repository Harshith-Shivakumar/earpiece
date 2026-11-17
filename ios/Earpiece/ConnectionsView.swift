import AVFoundation
import SwiftUI
import VisionKit

/// SPEC 11.4 Connections screen: saved bridges, swipe to delete, tap to edit, Scan QR, Add manually.
struct ConnectionsView: View {
    @ObservedObject var drive: DriveController
    @ObservedObject var store: ConnectionStore
    @State private var showScanner = false

    var body: some View {
        List {
            Section {
                if store.connections.isEmpty {
                    Text("No saved connections yet. Scan the QR code the bridge prints in its terminal.")
                        .foregroundStyle(.secondary)
                }
                ForEach(store.connections) { saved in
                    NavigationLink {
                        ConnectionEditView(drive: drive, original: saved)
                    } label: {
                        ConnectionRow(saved: saved, isSelected: saved.id == store.selectedID,
                                      livePath: saved.id == store.selectedID && drive.link == .connected ? drive.linkPath : nil)
                    }
                    .deleteDisabled(drive.isLive && saved.id == store.selectedID)
                }
                .onDelete { offsets in
                    let ids = offsets.map { store.connections[$0].id }
                    ids.forEach(store.delete)
                    drive.connectionsDidChange()
                }
            } footer: {
                if drive.isLive { Text("The connection in use can't be deleted during a drive.") }
            }

            Section {
                Button {
                    showScanner = true
                } label: {
                    Label("Scan QR", systemImage: "qrcode.viewfinder")
                }
                NavigationLink {
                    ConnectionEditView(drive: drive, original: nil)
                } label: {
                    Label("Add manually", systemImage: "plus")
                }
            } footer: {
                Text("The bridge prints a QR code when it starts, or run npm run pair on that machine. You can also scan it with the Camera app.")
            }
        }
        .navigationTitle("Connections")
        .sheet(isPresented: $showScanner) {
            ScanQRView(drive: drive)
        }
    }
}

private struct ConnectionRow: View {
    let saved: SavedConnection
    let isSelected: Bool
    /// Set while this connection is connected: "Connected via relay" / "Connected direct".
    let livePath: ConnectionPath?

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(saved.name)
                    .font(.headline)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .accessibilityLabel("Selected")
            }
        }
    }

    private var detail: String {
        if let livePath {
            return livePath == .relay ? "Connected via relay" : "Connected direct"
        }
        if saved.lastPath == ConnectionPath.relay.rawValue {
            return "Last worked via relay"
        }
        if saved.hasRelay && saved.lastURL == nil {
            return "Via relay, not used yet"
        }
        if let last = saved.lastURL, let url = URL(string: last) {
            let kind = ServerAddress.isTailscaleHost(url.host ?? "") ? "Tailscale" : "LAN"
            return "Last worked: \(url.host ?? last) (\(kind))"
        }
        let count = saved.urls.count
        return count == 1 ? "1 address, not used yet" : "\(count) addresses, not used yet"
    }
}

/// Rename, edit URLs and token, and Check every URL.
struct ConnectionEditView: View {
    @ObservedObject var drive: DriveController
    let original: SavedConnection?

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var urls: [String] = [""]
    @State private var token = ""
    @State private var results: [Int: String] = [:]
    @State private var checking = false
    @State private var loaded = false
    @State private var confirmForget = false

    var body: some View {
        Form {
            Section("Name") {
                TextField("Laptop", text: $name)
                    .autocorrectionDisabled()
            }
            if let original, original.hasRelay {
                Section {
                    LabeledContent("Relay", value: URL(string: original.relay ?? "")?.host ?? original.relay ?? "")
                    Text("End-to-end encrypted. The relay only passes messages it cannot read.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Relay")
                }
            }
            Section {
                ForEach(urls.indices, id: \.self) { index in
                    VStack(alignment: .leading, spacing: 4) {
                        TextField("ws://100.101.102.103:8787/ws", text: $urls[index])
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        if let result = results[index] {
                            Text(result)
                                .font(.footnote)
                                .foregroundStyle(result.hasPrefix("OK") ? .green : .secondary)
                        }
                    }
                }
                .onDelete { offsets in
                    urls.remove(atOffsets: offsets)
                    results = [:]
                    if urls.isEmpty { urls = [""] }
                }
                Button {
                    urls.append("")
                } label: {
                    Label("Add address", systemImage: "plus")
                }
            } header: {
                Text(hasRelay ? "Direct addresses (optional)" : "Addresses")
            } footer: {
                Text(hasRelay
                     ? "Used instead of the relay when one answers quickly. They need the bridge's token."
                     : "Tried in order; the one that last worked goes first. Tailscale addresses (100.x or .ts.net) work from anywhere while Tailscale is on.")
            }
            Section {
                SecureField("Token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text(hasRelay ? "Token (for direct addresses)" : "Token")
            }
            Section {
                Button {
                    Task { await check() }
                } label: {
                    HStack {
                        Text("Check")
                        if checking { Spacer(); ProgressView() }
                    }
                }
                .disabled(checking || validURLs.isEmpty)
            } footer: {
                Text("Asks every address for /health and shows which ones answer.")
            }
            if original != nil {
                Section {
                    Button("Forget this computer", role: .destructive) { confirmForget = true }
                        .disabled(drive.isLive && original?.id == drive.connections.selectedID)
                } footer: {
                    Text("Removes it from this phone. To revoke this phone on the computer, run npm run unpair there.")
                }
            }
        }
        .confirmationDialog("Forget \(original?.name ?? "this computer")?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget this computer", role: .destructive) { forget() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You will need to scan its QR code again to reconnect.")
        }
        .navigationTitle(original == nil ? "Add connection" : "Edit connection")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }
                    .disabled(!canSave)
            }
        }
        .onAppear(perform: load)
    }

    private var hasRelay: Bool { original?.hasRelay ?? false }

    /// A relay connection needs nothing else; a direct-only one needs an address and a token.
    private var canSave: Bool {
        hasRelay || (!validURLs.isEmpty && !token.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    private func forget() {
        guard let original else { return }
        drive.connections.delete(original.id)
        drive.connectionsDidChange()
        dismiss()
    }

    private var validURLs: [URL] {
        var out: [URL] = []
        for raw in urls {
            if let url = ServerAddress.webSocketURL(from: raw), !out.contains(url) { out.append(url) }
        }
        return out
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let original else { return }
        name = original.name
        urls = original.urls.isEmpty ? [""] : original.urls
        token = drive.connections.token(for: original.id)
    }

    private func save() {
        let list = validURLs.map(\.absoluteString)
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        var saved = original ?? SavedConnection(id: SavedConnection.placeholderID(), name: "", urls: [], lastURL: nil)
        saved.urls = list
        if let last = saved.lastURL, !list.contains(last) { saved.lastURL = nil }
        if trimmedName.isEmpty {
            saved.name = validURLs.first?.host ?? "Bridge"
            saved.nameIsDefault = true
        } else if trimmedName != original?.name {
            saved.name = trimmedName
            saved.nameIsDefault = false
        }
        drive.connections.save(saved, token: token)
        drive.connectionsDidChange()
        dismiss()
    }

    private func check() async {
        checking = true
        defer { checking = false }
        results = [:]
        let knownID = original.flatMap { $0.hasKnownID ? $0.id : nil }
        for (index, raw) in urls.enumerated() {
            guard let url = ServerAddress.webSocketURL(from: raw) else {
                results[index] = "Not a valid address."
                continue
            }
            switch await HealthCheck.check(url) {
            case .success(let info):
                let who = info.name ?? "bridge"
                if let knownID, let reported = info.bridgeID, reported != knownID {
                    results[index] = "Answers, but it is a different bridge (\(who))."
                } else {
                    results[index] = "OK: \(who) (\(info.state ?? "?"))"
                }
            case .failure(let error):
                results[index] = "No answer: \(error.localizedDescription)"
            }
        }
    }
}

/// "Add <name>?" for a pairing link (Camera app or in-app scanner).
struct PairingConfirmView: View {
    let info: PairingInfo
    let alreadySaved: Bool
    let onAdd: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add \(info.name)?")
                .font(.title.weight(.bold))
            Text(alreadySaved
                 ? "This bridge is already saved. Its addresses and token will be replaced."
                 : "Earpiece will save this bridge and its token on this iPhone.")
                .font(.body)
                .foregroundStyle(.secondary)
            if let relay = info.relay {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Via relay: \(relay.host ?? relay.absoluteString)", systemImage: "lock.fill")
                        .font(.headline)
                    Text("End-to-end encrypted. Works from any network.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                if !info.urls.isEmpty {
                    Text(info.hasRelay ? "Direct addresses" : "Addresses")
                        .font(.headline)
                }
                ForEach(info.urls, id: \.self) { url in
                    HStack {
                        Text(url.absoluteString)
                            .font(.callout.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if ServerAddress.isTailscaleHost(url.host ?? "") {
                            Text("Tailscale")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.blue.opacity(0.15), in: Capsule())
                        }
                    }
                }
            }
            Spacer()
            Button {
                onAdd()
            } label: {
                Text(alreadySaved ? "Update" : "Add")
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            Button("Cancel", role: .cancel) { onCancel() }
                .frame(maxWidth: .infinity)
        }
        .padding(24)
    }
}

/// In-app QR scanning with VisionKit (QR codes only).
struct ScanQRView: View {
    @ObservedObject var drive: DriveController
    @Environment(\.dismiss) private var dismiss
    @State private var found: PairingInfo?
    @State private var message: String?
    @State private var cameraAllowed: Bool?

    var body: some View {
        NavigationStack {
            Group {
                if let found {
                    PairingConfirmView(
                        info: found,
                        alreadySaved: drive.connections.connection(id: found.id) != nil,
                        onAdd: {
                            drive.confirmPairing(found)
                            dismiss()
                        },
                        onCancel: { self.found = nil })
                } else if !DataScannerViewController.isSupported {
                    unavailable("This iPhone can't scan in the app. Open the Camera app and point it at the QR code instead.")
                } else if cameraAllowed == false || (cameraAllowed == true && !DataScannerViewController.isAvailable) {
                    unavailable("Camera access is off. Turn it on in the Settings app under Earpiece, or use the Camera app.")
                } else if cameraAllowed == true {
                    ZStack(alignment: .bottom) {
                        QRScanner { payload in handle(payload) }
                            .ignoresSafeArea()
                        Text(message ?? "Point the camera at the QR code the bridge prints.")
                            .font(.headline)
                            .padding(12)
                            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                            .padding()
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Scan QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task { cameraAllowed = await Self.requestCamera() }
        }
    }

    private func unavailable(_ text: String) -> some View {
        Text(text)
            .font(.title3)
            .multilineTextAlignment(.center)
            .padding(32)
    }

    private func handle(_ payload: String) {
        switch Pairing.parse(payload) {
        case .success(let info): found = info
        case .failure(let error): message = error.message
        }
    }

    private static func requestCamera() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }
}

/// DataScannerViewController wrapper that reports QR payloads.
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void
        private var lastPayload: String?

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                guard case .barcode(let code) = item, let payload = code.payloadStringValue,
                      payload != lastPayload else { continue }
                lastPayload = payload
                onCode(payload)
            }
        }
    }
}
