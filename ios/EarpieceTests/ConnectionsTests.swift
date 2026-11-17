import Foundation
import Testing
@testable import Earpiece

// SPEC 11: pairing links, saved connections, URL order, drive_ended.

struct PairingTests {
    private func info(_ link: String) throws -> PairingInfo {
        try Pairing.parse(link).get()
    }

    @Test func parsesRepeatedEncodedURLs() throws {
        let link = "earpiece://pair?v=1&name=Harshiths-MacBook-Pro&id=6f1c2b7a-1111-2222-3333-444455556666&token=abc123"
            + "&url=ws%3A%2F%2Fharshiths-macbook-pro.tail1234.ts.net%3A8787%2Fws"
            + "&url=ws%3A%2F%2F100.101.102.103%3A8787%2Fws"
            + "&url=ws%3A%2F%2F192.168.1.20%3A8787%2Fws"
        let p = try info(link)
        #expect(p.id == "6f1c2b7a-1111-2222-3333-444455556666")
        #expect(p.name == "Harshiths-MacBook-Pro")
        #expect(p.token == "abc123")
        #expect(p.urls.map(\.absoluteString) == [
            "ws://harshiths-macbook-pro.tail1234.ts.net:8787/ws",
            "ws://100.101.102.103:8787/ws",
            "ws://192.168.1.20:8787/ws",
        ])
    }

    @Test func decodesNamesAndTokens() throws {
        #expect(try info("earpiece://pair?v=1&name=Work%20Laptop&id=b1&token=t%2Bx%2F%3D&url=ws://10.0.0.5:8787/ws").name == "Work Laptop")
        #expect(try info("earpiece://pair?v=1&name=Work%20Laptop&id=b1&token=t%2Bx%2F%3D&url=ws://10.0.0.5:8787/ws").token == "t+x/=")
        // Form encoding: "+" is a space in the name.
        #expect(try info("earpiece://pair?v=1&name=Home+Server&id=b1&token=t&url=ws://10.0.0.5:8787/ws").name == "Home Server")
        // Unencoded URL values and a missing name (falls back to the first host).
        let bare = try info("earpiece://pair?id=b1&token=t&url=ws://10.0.0.5:8787/ws")
        #expect(bare.name == "10.0.0.5")
        #expect(bare.urls.map(\.absoluteString) == ["ws://10.0.0.5:8787/ws"])
    }

    @Test func dropsInvalidAndDuplicateURLs() throws {
        let p = try info("earpiece://pair?v=1&name=A&id=b1&token=t&url=ftp%3A%2F%2Fx&url=ws://10.0.0.5:8787/ws&url=ws://10.0.0.5:8787/ws&url=")
        #expect(p.urls.map(\.absoluteString) == ["ws://10.0.0.5:8787/ws"])
    }

    @Test func rejectsBadLinks() {
        #expect(Pairing.parse("earpiece://pair?v=1&name=A&id=b1&url=ws://10.0.0.5:8787/ws") == .failure(.missingToken))
        #expect(Pairing.parse("earpiece://pair?v=1&name=A&id=b1&token=&url=ws://10.0.0.5:8787/ws") == .failure(.missingToken))
        #expect(Pairing.parse("earpiece://pair?v=1&name=A&token=t&url=ws://10.0.0.5:8787/ws") == .failure(.missingID))
        #expect(Pairing.parse("earpiece://pair?v=1&name=A&id=b1&token=t") == .failure(.noURLs))
        #expect(Pairing.parse("earpiece://pair?v=3&name=A&id=b1&token=t&url=ws://10.0.0.5:8787/ws") == .failure(.unsupportedVersion))
        #expect(Pairing.parse("https://example.com/pair?id=b1&token=t") == .failure(.notPairingLink))
        #expect(Pairing.parse("earpiece://other?id=b1&token=t") == .failure(.notPairingLink))
        #expect(Pairing.parse("hello world") == .failure(.notPairingLink))
    }
}

struct ConnectionListTests {
    private func pairing(id: String = "bridge-1", name: String = "Laptop", urls: [String]) -> PairingInfo {
        PairingInfo(id: id, name: name, token: "tok", urls: urls.compactMap { ServerAddress.webSocketURL(from: $0) })
    }

    @Test func migratesLegacySetting() throws {
        let migrated = try #require(ConnectionList.migrateLegacy(serverURL: "192.168.1.20", token: "secret", id: "pending-x"))
        #expect(migrated.id == "pending-x")
        #expect(!migrated.hasKnownID)
        #expect(migrated.name == "192.168.1.20")
        #expect(migrated.nameIsDefault)
        #expect(migrated.urls == ["ws://192.168.1.20:8787/ws"])
        #expect(migrated.lastURL == nil)
        #expect(ConnectionList.migrateLegacy(serverURL: "", token: "secret") == nil)
        #expect(ConnectionList.migrateLegacy(serverURL: "ftp://nope", token: nil) == nil)
        #expect(SavedConnection.placeholderID().hasPrefix(SavedConnection.placeholderPrefix))
    }

    @Test func rekeyLearnsIdAndName() {
        let list = [SavedConnection(id: "pending-x", name: "192.168.1.20", urls: ["ws://192.168.1.20:8787/ws"], lastURL: "ws://192.168.1.20:8787/ws", nameIsDefault: true)]
        let out = ConnectionList.rekey(list, from: "pending-x", to: "bridge-1", bridgeName: "Laptop")
        #expect(out.count == 1)
        #expect(out[0].id == "bridge-1" && out[0].hasKnownID)
        #expect(out[0].name == "Laptop" && !out[0].nameIsDefault)
        #expect(out[0].lastURL == "ws://192.168.1.20:8787/ws")
        // A name the user typed is kept.
        let named = [SavedConnection(id: "pending-y", name: "My box", urls: ["ws://10.0.0.5:8787/ws"], lastURL: nil, nameIsDefault: false)]
        #expect(ConnectionList.rekey(named, from: "pending-y", to: "b2", bridgeName: "Laptop")[0].name == "My box")
    }

    @Test func rekeyMergesIntoExistingId() {
        let list = [
            SavedConnection(id: "bridge-1", name: "Laptop", urls: ["ws://100.101.102.103:8787/ws"], lastURL: nil),
            SavedConnection(id: "pending-x", name: "192.168.1.20", urls: ["ws://192.168.1.20:8787/ws"], lastURL: "ws://192.168.1.20:8787/ws", nameIsDefault: true),
        ]
        let out = ConnectionList.rekey(list, from: "pending-x", to: "bridge-1", bridgeName: "Laptop")
        #expect(out.map(\.id) == ["bridge-1"])
        #expect(out[0].urls == ["ws://100.101.102.103:8787/ws", "ws://192.168.1.20:8787/ws"])
        #expect(out[0].lastURL == "ws://192.168.1.20:8787/ws")
    }

    @Test func pairingAddsThenUpdatesWithoutDuplicates() {
        let first = ConnectionList.upsert([], pairing: pairing(urls: ["ws://100.101.102.103:8787/ws"]))
        #expect(first.list.map(\.id) == ["bridge-1"])
        var list = first.list
        list[0].lastURL = "ws://100.101.102.103:8787/ws"
        let again = ConnectionList.upsert(list, pairing: pairing(name: "Laptop (new)", urls: ["ws://100.101.102.103:8787/ws", "ws://10.0.0.9:8787/ws"]))
        #expect(again.list.count == 1)
        #expect(again.list[0].name == "Laptop (new)")
        #expect(again.list[0].urls == ["ws://100.101.102.103:8787/ws", "ws://10.0.0.9:8787/ws"])
        #expect(again.list[0].lastURL == "ws://100.101.102.103:8787/ws")  // still saved, so kept
        #expect(again.replaced.isEmpty)
    }

    @Test func pairingReplacesMigratedPlaceholderForSameBridge() {
        let list = [
            SavedConnection(id: "other", name: "Server", urls: ["ws://10.0.0.2:8787/ws"], lastURL: nil),
            SavedConnection(id: "pending-x", name: "192.168.1.20", urls: ["ws://192.168.1.20:8787/ws"], lastURL: nil, nameIsDefault: true),
        ]
        let out = ConnectionList.upsert(list, pairing: pairing(urls: ["ws://100.101.102.103:8787/ws", "ws://192.168.1.20:8787/ws"]))
        #expect(out.list.map(\.id) == ["other", "bridge-1"])
        #expect(out.replaced == ["pending-x"])
    }
}

struct ConnectionOrderTests {
    let lan = URL(string: "ws://192.168.1.20:8787/ws")!
    let ts = URL(string: "ws://100.101.102.103:8787/ws")!
    let magic = URL(string: "ws://laptop.tail1234.ts.net:8787/ws")!

    @Test func lastURLFirstThenSavedOrder() {
        #expect(ConnectionOrder.order(urls: [magic, ts, lan], lastURL: lan) == [lan, magic, ts])
        #expect(ConnectionOrder.order(urls: [magic, ts, lan], lastURL: nil) == [magic, ts, lan])
        // A last URL that is no longer saved is ignored.
        #expect(ConnectionOrder.order(urls: [magic, ts], lastURL: lan) == [magic, ts])
        #expect(ConnectionOrder.order(urls: [ts, ts, lan], lastURL: ts) == [ts, lan])
    }

    @Test func unreachableMessage() {
        #expect(ConnectionOrder.unreachableMessage(name: "Laptop", urls: [ts, lan]) == "Can't reach Laptop. Is Tailscale on?")
        #expect(ConnectionOrder.unreachableMessage(name: "Laptop", urls: [magic]) == "Can't reach Laptop. Is Tailscale on?")
        #expect(ConnectionOrder.unreachableMessage(name: "Laptop", urls: [lan]) == "Can't reach Laptop.")
    }

    @Test func tailscaleHosts() {
        for host in ["100.64.0.1", "100.101.102.103", "100.127.255.254", "laptop.tail1234.ts.net", "LAPTOP.TAIL1234.TS.NET"] {
            #expect(ServerAddress.isTailscaleHost(host), "\(host)")
        }
        for host in ["100.63.0.1", "100.128.0.1", "192.168.1.20", "10.0.0.1", "100.101.102", "example.com", "ts.net.example.com"] {
            #expect(!ServerAddress.isTailscaleHost(host), "\(host)")
        }
    }

    @Test func healthAcceptance() throws {
        let info = HealthInfo(ok: true, state: "idle", name: "Laptop", bridgeID: "bridge-1")
        #expect(HealthCheck.accepts(info, expectedBridgeID: "bridge-1"))
        #expect(!HealthCheck.accepts(info, expectedBridgeID: "bridge-2"))
        #expect(HealthCheck.accepts(info, expectedBridgeID: nil))  // migrated: id not known yet
        #expect(!HealthCheck.accepts(HealthInfo(ok: true), expectedBridgeID: "bridge-1"))
        #expect(!HealthCheck.accepts(HealthInfo(ok: false, bridgeID: "bridge-1"), expectedBridgeID: "bridge-1"))
        let decoded = try JSONDecoder().decode(HealthInfo.self, from: Data(#"{"ok":true,"state":"idle","name":"Laptop","bridge_id":"bridge-1"}"#.utf8))
        #expect(decoded == info)
        let old = try JSONDecoder().decode(HealthInfo.self, from: Data(#"{"ok":true,"state":"working"}"#.utf8))
        #expect(old.bridgeID == nil && old.ok)
    }
}

struct DriveEndedTests {
    @Test func decodesDriveEnded() throws {
        let text = #"""
        {"type":"drive_ended","drive_id":"2026-11-15_09-00-00","chats":[
          {"id":"s1","title":"Fix upload timeouts","cwd":"/Users/me/code/uploader","folder":"uploader",
           "resume_cmd":"cd /Users/me/code/uploader && claude --resume s1"},
          {"id":"s2","cwd":"/Users/me/My Site"},
          {"title":"no id, skipped"}
        ]}
        """#
        guard case .driveEnded(let ended) = try Wire.decode(text) else { Issue.record("not drive_ended"); return }
        #expect(ended.driveID == "2026-11-15_09-00-00")
        #expect(ended.chats.map(\.id) == ["s1", "s2"])
        #expect(ended.chats[0] == EndedChat(id: "s1", title: "Fix upload timeouts", cwd: "/Users/me/code/uploader",
                                            folder: "uploader", resumeCmd: "cd /Users/me/code/uploader && claude --resume s1"))
        // Missing fields: title, folder from cwd, and a quoted fallback command.
        #expect(ended.chats[1].title == "Untitled chat")
        #expect(ended.chats[1].folder == "My Site")
        #expect(ended.chats[1].resumeCmd == "cd '/Users/me/My Site' && claude --resume s2")
        #expect(try Wire.decode(#"{"type":"drive_ended"}"#) == .driveEnded(DriveEnded(driveID: "", chats: [])))
    }

    @Test func driveEndedRoundTrip() throws {
        let message = ServerMessage.driveEnded(DriveEnded(driveID: "d", chats: [
            EndedChat(id: "s1", title: "T", cwd: "/a/b", folder: "b", resumeCmd: "cd /a/b && claude --resume s1"),
        ]))
        let data = try JSONEncoder().encode(message)
        #expect(try JSONDecoder().decode(ServerMessage.self, from: data) == message)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["type"] as? String == "drive_ended")
    }

    @Test func endDriveControlShapes() throws {
        let plain = try #require(JSONSerialization.jsonObject(with: Data(try Wire.encode(.control(action: .endDrive)).utf8)) as? NSDictionary)
        #expect(plain == ["type": "control", "action": "end_drive"] as NSDictionary)
        let forced = try #require(JSONSerialization.jsonObject(with: Data(try Wire.encode(.control(action: .endDrive, force: true)).utf8)) as? NSDictionary)
        #expect(forced == ["type": "control", "action": "end_drive", "force": true] as NSDictionary)
        let data = try JSONEncoder().encode(ClientMessage.control(action: .endDrive, force: true))
        #expect(try JSONDecoder().decode(ClientMessage.self, from: data) == .control(action: .endDrive, force: true))
    }

    @Test func busyErrorAndWelcomeIdentity() throws {
        #expect(try Wire.decode(#"{"type":"error","code":"busy","message":"Claude is still working."}"#)
                == .error(ServerError(code: "busy", message: "Claude is still working.")))
        let welcome = try Wire.decode(#"{"type":"welcome","drive_id":"d","cwd":"/a","state":"idle","seq":3,"chat":null,"name":"Laptop","bridge_id":"bridge-1"}"#)
        #expect(welcome == .welcome(Welcome(driveID: "d", cwd: "/a", state: .idle, seq: 3, chat: .none, name: "Laptop", bridgeID: "bridge-1")))
        let old = try Wire.decode(#"{"type":"welcome","drive_id":"d","cwd":"/a","state":"idle","seq":3}"#)
        #expect(old == .welcome(Welcome(driveID: "d", cwd: "/a", state: .idle, seq: 3)))
    }
}
