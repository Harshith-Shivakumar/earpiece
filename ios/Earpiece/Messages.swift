import Foundation

// SPEC section 1: the phone <-> bridge WebSocket protocol.
// Every frame is one JSON text message with a "type" field. Keys are snake_case.

/// Bridge session state. The bridge is the source of truth.
enum BridgeState: Equatable, Codable {
    case idle
    case holding
    case working
    case waitingForYou
    case other(String)

    init(wire: String) {
        switch wire {
        case "idle": self = .idle
        case "holding": self = .holding
        case "working": self = .working
        case "waiting_for_you": self = .waitingForYou
        default: self = .other(wire)
        }
    }

    var wire: String {
        switch self {
        case .idle: return "idle"
        case .holding: return "holding"
        case .working: return "working"
        case .waitingForYou: return "waiting_for_you"
        case .other(let value): return value
        }
    }

    var label: String {
        switch self {
        case .idle: return "Idle"
        case .holding: return "Holding"
        case .working: return "Working"
        case .waitingForYou: return "Waiting for you"
        case .other(let value): return value
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(wire: try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wire)
    }
}

/// `kind` of a `say` event.
enum SayKind: Equatable, Codable {
    case ack, progress, reply, question, notice, error
    case other(String)

    init(wire: String) {
        switch wire {
        case "ack": self = .ack
        case "progress": self = .progress
        case "reply": self = .reply
        case "question": self = .question
        case "notice": self = .notice
        case "error": self = .error
        default: self = .other(wire)
        }
    }

    var wire: String {
        switch self {
        case .ack: return "ack"
        case .progress: return "progress"
        case .reply: return "reply"
        case .question: return "question"
        case .notice: return "notice"
        case .error: return "error"
        case .other(let value): return value
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(wire: try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wire)
    }
}

/// `action` of a `control` message.
enum ControlAction: String, Codable, CaseIterable {
    case cancel
    case stop
    case status
    case `repeat`
    case pause
    case resume
    case endDrive = "end_drive"
    // SPEC 10.3 voice chat controls
    case switchChat = "switch_chat"
    case newChat = "new_chat"
    case whichChat = "which_chat"
}

// MARK: - Phone -> bridge

enum ClientMessage: Equatable, Codable {
    /// `token` is nil over the relay: the Noise session already authenticated the phone (SPEC 12.3).
    case hello(token: String?, lastSeq: Int, client: String)
    case utterance(text: String)
    /// `force` is only sent when true (SPEC 11.5: `end_drive` with `force:true`).
    case control(action: ControlAction, force: Bool = false)
    case ping
    // SPEC 10.3
    case listChats
    case openChat(id: String)
    case newChat(cwd: String?)

    private enum CodingKeys: String, CodingKey {
        case type
        case token
        case lastSeq = "last_seq"
        case client
        case text
        case action
        case force
        case id
        case cwd
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .hello(token, lastSeq, client):
            try c.encode("hello", forKey: .type)
            try c.encodeIfPresent(token, forKey: .token)
            try c.encode(lastSeq, forKey: .lastSeq)
            try c.encode(client, forKey: .client)
        case let .utterance(text):
            try c.encode("utterance", forKey: .type)
            try c.encode(text, forKey: .text)
        case let .control(action, force):
            try c.encode("control", forKey: .type)
            try c.encode(action, forKey: .action)
            if force { try c.encode(true, forKey: .force) }
        case .ping:
            try c.encode("ping", forKey: .type)
        case .listChats:
            try c.encode("list_chats", forKey: .type)
        case let .openChat(id):
            try c.encode("open_chat", forKey: .type)
            try c.encode(id, forKey: .id)
        case let .newChat(cwd):
            try c.encode("new_chat", forKey: .type)
            try c.encodeIfPresent(cwd, forKey: .cwd)
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hello":
            self = .hello(token: try c.decodeIfPresent(String.self, forKey: .token),
                          lastSeq: try c.decode(Int.self, forKey: .lastSeq),
                          client: try c.decodeIfPresent(String.self, forKey: .client) ?? "")
        case "utterance":
            self = .utterance(text: try c.decode(String.self, forKey: .text))
        case "control":
            self = .control(action: try c.decode(ControlAction.self, forKey: .action),
                            force: (try? c.decodeIfPresent(Bool.self, forKey: .force)) ?? false)
        case "ping":
            self = .ping
        case "list_chats":
            self = .listChats
        case "open_chat":
            self = .openChat(id: try c.decode(String.self, forKey: .id))
        case "new_chat":
            self = .newChat(cwd: try c.decodeIfPresent(String.self, forKey: .cwd))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown client message type \(type)")
        }
    }
}

// MARK: - Bridge -> phone

struct Welcome: Equatable, Codable {
    var driveID: String
    var cwd: String
    var state: BridgeState
    var seq: Int
    var chat: ChatField = .absent
    /// SPEC 11.1 bridge identity (nil from older bridges).
    var name: String?
    var bridgeID: String?

    private enum CodingKeys: String, CodingKey {
        case driveID = "drive_id"
        case bridgeID = "bridge_id"
        case cwd, state, seq, chat, name
    }

    init(driveID: String, cwd: String, state: BridgeState, seq: Int, chat: ChatField = .absent,
         name: String? = nil, bridgeID: String? = nil) {
        self.driveID = driveID
        self.cwd = cwd
        self.state = state
        self.seq = seq
        self.chat = chat
        self.name = name
        self.bridgeID = bridgeID
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(driveID, forKey: .driveID)
        try c.encode(cwd, forKey: .cwd)
        try c.encode(state, forKey: .state)
        try c.encode(seq, forKey: .seq)
        try chat.encode(into: &c, forKey: .chat)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(bridgeID, forKey: .bridgeID)
    }

    // Lenient: a missing optional field should not drop the whole welcome.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .driveID) {
            driveID = s
        } else if let n = try? c.decode(Int.self, forKey: .driveID) {
            driveID = String(n)
        } else {
            driveID = ""
        }
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        state = (try? c.decodeIfPresent(BridgeState.self, forKey: .state)) ?? .idle
        seq = (try? c.decodeIfPresent(Int.self, forKey: .seq)) ?? 0
        chat = ChatField.decode(from: c, forKey: .chat)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        bridgeID = try? c.decodeIfPresent(String.self, forKey: .bridgeID)
    }
}

// MARK: - drive_ended (SPEC 11.5)

/// One chat to continue at the desk.
struct EndedChat: Equatable, Identifiable, Codable {
    var id: String
    var title: String
    var cwd: String
    var folder: String
    var resumeCmd: String

    init(id: String, title: String, cwd: String, folder: String, resumeCmd: String) {
        self.id = id
        self.title = title
        self.cwd = cwd
        self.folder = folder
        self.resumeCmd = resumeCmd
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, cwd, folder
        case resumeCmd = "resume_cmd"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let t = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        title = t.isEmpty ? "Untitled chat" : t
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        let f = (try? c.decodeIfPresent(String.self, forKey: .folder)) ?? ""
        folder = f.isEmpty ? (cwd as NSString).lastPathComponent : f
        let cmd = (try? c.decodeIfPresent(String.self, forKey: .resumeCmd)) ?? ""
        resumeCmd = cmd.isEmpty ? Self.resumeCommand(id: id, cwd: cwd) : cmd
    }

    /// Fallback when the bridge sends no `resume_cmd`: `cd <cwd> && claude --resume <id>`.
    static func resumeCommand(id: String, cwd: String) -> String {
        guard !cwd.isEmpty else { return "claude --resume \(id)" }
        let safe = cwd.allSatisfy { $0.isLetter || $0.isNumber || "/._-~".contains($0) }
        let quoted = safe ? cwd : "'" + cwd.replacingOccurrences(of: "'", with: "'\\''") + "'"
        return "cd \(quoted) && claude --resume \(id)"
    }
}

struct DriveEnded: Equatable, Codable {
    var driveID: String
    var chats: [EndedChat]

    init(driveID: String, chats: [EndedChat]) {
        self.driveID = driveID
        self.chats = chats
    }

    private enum CodingKeys: String, CodingKey {
        case driveID = "drive_id"
        case chats
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        driveID = (try? c.decodeIfPresent(String.self, forKey: .driveID)) ?? ""
        let raw = (try? c.decodeIfPresent([Lenient].self, forKey: .chats)) ?? []
        chats = raw.compactMap(\.value)
    }

    private struct Lenient: Decodable {
        let value: EndedChat?
        init(from decoder: Decoder) throws { value = try? EndedChat(from: decoder) }
    }
}

struct Say: Equatable, Codable {
    var seq: Int
    var text: String
    var kind: SayKind

    init(seq: Int, text: String, kind: SayKind) {
        self.seq = seq
        self.text = text
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey { case seq, text, kind }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        text = try c.decode(String.self, forKey: .text)
        kind = (try? c.decodeIfPresent(SayKind.self, forKey: .kind)) ?? .notice
    }
}

struct StateChange: Equatable, Codable {
    var state: BridgeState
    var cwd: String?
    var chat: ChatField = .absent

    init(state: BridgeState, cwd: String?, chat: ChatField = .absent) {
        self.state = state
        self.cwd = cwd
        self.chat = chat
    }

    private enum CodingKeys: String, CodingKey { case state, cwd, chat }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = (try? c.decodeIfPresent(BridgeState.self, forKey: .state)) ?? .idle
        cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
        chat = ChatField.decode(from: c, forKey: .chat)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(state, forKey: .state)
        try c.encodeIfPresent(cwd, forKey: .cwd)
        try chat.encode(into: &c, forKey: .chat)
    }
}

// MARK: - Chats (SPEC 10)

/// The active chat as carried by `welcome` and `state`.
struct ChatRef: Equatable, Codable {
    var id: String
    var title: String

    init(id: String, title: String) {
        self.id = id
        self.title = title
    }

    private enum CodingKeys: String, CodingKey { case id, title }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let t = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        title = t.isEmpty ? "Untitled chat" : t
    }
}

/// `chat` on welcome/state: missing (older bridge, keep what we know), null (no chat open) or a chat.
enum ChatField: Equatable {
    case absent
    case none
    case chat(ChatRef)

    static func decode<K: CodingKey>(from c: KeyedDecodingContainer<K>, forKey key: K) -> ChatField {
        guard c.contains(key) else { return .absent }
        if (try? c.decodeNil(forKey: key)) == true { return .none }
        if let ref = try? c.decode(ChatRef.self, forKey: key) { return .chat(ref) }
        return .absent
    }

    func encode<K: CodingKey>(into c: inout KeyedEncodingContainer<K>, forKey key: K) throws {
        switch self {
        case .absent: break
        case .none: try c.encodeNil(forKey: key)
        case .chat(let ref): try c.encode(ref, forKey: key)
        }
    }
}

/// One row of `chats.items`.
struct ChatItem: Equatable, Identifiable, Codable {
    var id: String
    var title: String
    var cwd: String
    var folder: String
    var source: String
    var updatedAt: Date?
    var recentlyActive: Bool
    var current: Bool

    init(id: String, title: String, cwd: String = "", folder: String = "", source: String = "",
         updatedAt: Date? = nil, recentlyActive: Bool = false, current: Bool = false) {
        self.id = id
        self.title = title
        self.cwd = cwd
        self.folder = folder
        self.source = source
        self.updatedAt = updatedAt
        self.recentlyActive = recentlyActive
        self.current = current
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, cwd, folder, source
        case updatedAt = "updated_at"
        case recentlyActive = "recently_active"
        case current
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let t = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        title = t.isEmpty ? "Untitled chat" : t
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        let f = (try? c.decodeIfPresent(String.self, forKey: .folder)) ?? ""
        folder = f.isEmpty ? (cwd as NSString).lastPathComponent : f
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? ""
        updatedAt = ((try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? nil).flatMap(Self.parseDate)
        recentlyActive = (try? c.decodeIfPresent(Bool.self, forKey: .recentlyActive)) ?? false
        current = (try? c.decodeIfPresent(Bool.self, forKey: .current)) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(cwd, forKey: .cwd)
        try c.encode(folder, forKey: .folder)
        try c.encode(source, forKey: .source)
        try c.encodeIfPresent(updatedAt.map(Self.formatDate), forKey: .updatedAt)
        try c.encode(recentlyActive, forKey: .recentlyActive)
        try c.encode(current, forKey: .current)
    }

    /// ISO 8601 with or without fractional seconds (Node's toISOString has them).
    static func parseDate(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }

    static func formatDate(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }
}

/// `chats` message. Items that fail to decode are skipped rather than failing the list.
struct ChatList: Equatable, Codable {
    var items: [ChatItem]

    init(items: [ChatItem]) { self.items = items }

    private enum CodingKeys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decodeIfPresent([LenientItem].self, forKey: .items)) ?? []
        items = raw.compactMap(\.value)
    }

    private struct LenientItem: Decodable {
        let value: ChatItem?
        init(from decoder: Decoder) throws { value = try? ChatItem(from: decoder) }
    }
}

struct ServerError: Equatable, Codable {
    var code: String
    var message: String

    init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    private enum CodingKeys: String, CodingKey { case code, message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = (try? c.decodeIfPresent(String.self, forKey: .code)) ?? "unknown"
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
    }
}

enum ServerMessage: Equatable, Codable {
    case welcome(Welcome)
    case say(Say)
    case state(StateChange)
    case error(ServerError)
    case chats(ChatList)
    case driveEnded(DriveEnded)
    case pong
    case unknown(type: String)

    private enum TypeKey: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: TypeKey.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "welcome": self = .welcome(try Welcome(from: decoder))
        case "say": self = .say(try Say(from: decoder))
        case "state": self = .state(try StateChange(from: decoder))
        case "error": self = .error(try ServerError(from: decoder))
        case "chats": self = .chats(try ChatList(from: decoder))
        case "drive_ended": self = .driveEnded(try DriveEnded(from: decoder))
        case "pong": self = .pong
        default: self = .unknown(type: type)
        }
    }

    func encode(to encoder: Encoder) throws {
        let type: String
        switch self {
        case .welcome(let w): try w.encode(to: encoder); type = "welcome"
        case .say(let s): try s.encode(to: encoder); type = "say"
        case .state(let s): try s.encode(to: encoder); type = "state"
        case .error(let e): try e.encode(to: encoder); type = "error"
        case .chats(let list): try list.encode(to: encoder); type = "chats"
        case .driveEnded(let ended): try ended.encode(to: encoder); type = "drive_ended"
        case .pong: type = "pong"
        case .unknown(let t): type = t
        }
        var c = encoder.container(keyedBy: TypeKey.self)
        try c.encode(type, forKey: .type)
    }
}

/// JSON text framing helpers.
enum Wire {
    static func encode(_ message: ClientMessage) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(message)
        return String(decoding: data, as: UTF8.self)
    }

    static func decode(_ text: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(text.utf8))
    }
}
