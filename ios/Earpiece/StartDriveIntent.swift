import AppIntents

/// "Start a drive in Earpiece": opens the app and starts a drive (SPEC 8, Siri).
struct StartDriveIntent: AppIntent {
    static let title: LocalizedStringResource = "Start a Drive"
    static let description = IntentDescription("Opens Earpiece and starts a hands-free drive with Claude Code.")
    static let supportedModes: IntentModes = .foreground

    @MainActor
    func perform() async throws -> some IntentResult {
        DriveController.shared.start()
        return .result()
    }
}

struct EarpieceShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartDriveIntent(),
            phrases: ["Start a drive in \(.applicationName)"],
            shortTitle: "Start a Drive",
            systemImageName: "car.fill"
        )
    }
}
