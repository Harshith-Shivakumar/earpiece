import AVFoundation
import SwiftUI

/// Settings: connections, contextual words, voice, rate and silence timeout.
struct SettingsView: View {
    @ObservedObject var settings: SettingsStore
    @ObservedObject var drive: DriveController
    var isLive: Bool { drive.isLive }

    @Environment(\.dismiss) private var dismiss
    @State private var voices: [VoiceOption] = []
    @State private var tester = VoiceTester()

    var body: some View {
        NavigationStack {
            Form {
                serverSection
                wordsSection
                voiceSection
                turnSection
                Section {
                    Text("Only text is sent to your server. Speech recognition runs on the phone when the phone supports it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear { voices = VoiceOption.all() }
        }
    }

    private var serverSection: some View {
        Section {
            NavigationLink {
                ConnectionsView(drive: drive, store: drive.connections)
            } label: {
                HStack {
                    Label("Connections", systemImage: "desktopcomputer")
                    Spacer()
                    Text(drive.connections.selected?.name ?? "None")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        } header: {
            Text("Bridge")
        } footer: {
            Text("Saved bridges with their addresses and tokens. Scan the QR code a bridge prints to add it.")
        }
    }

    private var wordsSection: some View {
        Section {
            TextEditor(text: $settings.contextualWordsText)
                .frame(minHeight: 120)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } header: {
            Text("Words to recognize")
        } footer: {
            Text("One per line: repo names, tools, project words. Helps speech recognition with technical terms. Applies to the next turn.")
        }
    }

    private var voiceSection: some View {
        Section {
            Picker("Voice", selection: $settings.voiceIdentifier) {
                Text("Best available").tag("")
                ForEach(voices) { voice in
                    Text(voice.label).tag(voice.id)
                }
            }
            VStack(alignment: .leading) {
                Text("Speaking rate: \(String(format: "%.2f", settings.speechRate))")
                Slider(value: $settings.speechRate, in: 0.40...0.65, step: 0.01)
            }
            Button("Test voice") {
                tester.speak("Reading upload dot ts. Three steps so far.", voiceID: settings.voiceIdentifier, rate: settings.speechRate)
            }
            .disabled(isLive)
        } header: {
            Text("Voice")
        } footer: {
            Text("Download Premium or Enhanced voices in the Settings app: Accessibility, Spoken Content, Voices. Test voice is off during a drive.")
        }
    }

    private var turnSection: some View {
        Section {
            Stepper(value: $settings.silenceTimeout, in: 0.6...3.0, step: 0.1) {
                Text("End of turn after \(String(format: "%.1f", settings.silenceTimeout)) s")
            }
        } header: {
            Text("Turn taking")
        } footer: {
            Text("How long a pause ends your turn. Longer is safer if you pause mid-sentence.")
        }
    }
}

struct VoiceOption: Identifiable, Hashable {
    let id: String
    let label: String

    static func all() -> [VoiceOption] {
        Speaker.englishVoices().map {
            VoiceOption(id: $0.identifier, label: "\($0.name) (\($0.language), \(Speaker.qualityLabel($0.quality)))")
        }
    }
}

/// Plays a sample outside a drive, with the system's own audio path.
@MainActor
final class VoiceTester {
    private let synthesizer = AVSpeechSynthesizer()

    func speak(_ text: String, voiceID: String, rate: Float) {
        synthesizer.stopSpeaking(at: .immediate)
        // Play even with the silent switch on.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Speaker.voice(for: voiceID)
        utterance.rate = rate
        synthesizer.speak(utterance)
    }
}
