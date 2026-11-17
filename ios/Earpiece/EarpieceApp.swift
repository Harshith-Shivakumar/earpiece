import SwiftUI

@main
struct EarpieceApp: App {
    @StateObject private var drive = DriveController.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView(drive: drive)
                .onOpenURL { url in drive.handleOpenURL(url) }  // earpiece://pair?... (SPEC 11.3)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: drive.appDidBecomeActive()
            case .background: drive.appDidEnterBackground()
            default: break
            }
        }
    }
}
