import Foundation
import Testing
@testable import Earpiece

// SPEC 12: pairing link v2, path choice, relay framing.

struct PairingV2Tests {
    let key = "8rw5guHoxmiQiDttzBouT4Vdh0psUGvSRGj0esc7WSw"  // 32 bytes, base64url

    @Test func parsesFullV2Link() throws {
        let link = "earpiece://pair?v=2&name=Harshiths-MacBook-Pro&id=6f1c2b7a-1111-2222-3333-444455556666"
            + "&relay=wss%3A%2F%2Fearpiece-relay.example.workers.dev&key=\(key)&secret=AAAAAAAAAAAAAAAAAAAAAA"
            + "&url=ws%3A%2F%2F100.101.102.103%3A8787%2Fws&url=ws%3A%2F%2F192.168.1.20%3A8787%2Fws"
        let p = try Pairing.parse(link).get()
        #expect(p.version == 2)
        #expect(p.id == "6f1c2b7a-1111-2222-3333-444455556666")
        #expect(p.name == "Harshiths-MacBook-Pro")
        #expect(p.relay?.absoluteString == "wss://earpiece-relay.example.workers.dev")
        #expect(p.bridgeKey == Base64URL.decode(key))
        #expect(p.bridgeKey?.count == 32)
        #expect(p.pairSecret == "AAAAAAAAAAAAAAAAAAAAAA")
        #expect(p.token == nil)
        #expect(p.hasRelay)
        #expect(p.urls.map(\.absoluteString) == ["ws://100.101.102.103:8787/ws", "ws://192.168.1.20:8787/ws"])
    }

    @Test func v2TokenForDirectURLs() throws {
        let p = try Pairing.parse("earpiece://pair?v=2&name=Box&id=b1&relay=wss://r.example&key=\(key)&secret=s1&token=tok%2B1&url=ws://10.0.0.5:8787/ws").get()
        #expect(p.token == "tok+1")
        #expect(p.urls.map(\.absoluteString) == ["ws://10.0.0.5:8787/ws"])
        #expect(p.hasRelay)
    }

    @Test func v2DirectURLsAreOptional() throws {
        let p = try Pairing.parse("earpiece://pair?v=2&name=Box&id=b1&relay=ws://127.0.0.1:8790&key=\(key)&secret=s1").get()
        #expect(p.urls.isEmpty)
        #expect(p.relay?.absoluteString == "ws://127.0.0.1:8790")
    }

    @Test func v2Errors() {
        #expect(Pairing.parse("earpiece://pair?v=2&name=Box&id=b1&key=\(key)&secret=s") == .failure(.missingRelay))
        #expect(Pairing.parse("earpiece://pair?v=2&name=Box&id=b1&relay=ftp://x&key=\(key)") == .failure(.missingRelay))
        #expect(Pairing.parse("earpiece://pair?v=2&name=Box&id=b1&relay=wss://r.example") == .failure(.badKey))
        #expect(Pairing.parse("earpiece://pair?v=2&name=Box&id=b1&relay=wss://r.example&key=AAAA") == .failure(.badKey))
        #expect(Pairing.parse("earpiece://pair?v=2&name=Box&relay=wss://r.example&key=\(key)") == .failure(.missingID))
        #expect(Pairing.parse("earpiece://pair?v=3&id=b1") == .failure(.unsupportedVersion))
    }

    @Test func v1LinksStayDirectOnly() throws {
        let p = try Pairing.parse("earpiece://pair?v=1&name=Old&id=b1&token=t&url=ws://10.0.0.5:8787/ws").get()
        #expect(p.version == 1 && !p.hasRelay && p.token == "t")
        #expect(Pairing.parse("earpiece://pair?v=1&name=Old&id=b1&url=ws://10.0.0.5:8787/ws") == .failure(.missingToken))
    }

    @Test func v2PairingUpdatesExistingConnectionAndKeepsDirectURLs() throws {
        let existing = SavedConnection(id: "b1", name: "Laptop", urls: ["ws://10.0.0.5:8787/ws"],
                                       lastURL: "ws://10.0.0.5:8787/ws", nameIsDefault: false)
        let pairing = try Pairing.parse("earpiece://pair?v=2&name=Laptop&id=b1&relay=wss://r.example&key=\(key)&secret=s1").get()
        let out = ConnectionList.upsert([existing], pairing: pairing).list
        #expect(out.count == 1)
        #expect(out[0].urls == ["ws://10.0.0.5:8787/ws"])  // the link had no URLs: keep them
        #expect(out[0].lastURL == "ws://10.0.0.5:8787/ws")
        #expect(out[0].relay == "wss://r.example")
        #expect(out[0].bridgeKey == key)
        #expect(out[0].hasRelay)
    }
}

struct PathRaceTests {
    let url = URL(string: "ws://192.168.1.20:8787/ws")!

    @Test func directWinsWhenItAnswersFirst() {
        var race = PathRace(hasRelay: true, hasDirect: true)
        #expect(race.directAnswered(url) == .direct(url))
        #expect(race.relayReady() == .direct(url))  // decided; the relay is closed
    }

    @Test func relayWinsWhenItsHandshakeFinishesFirst() {
        var race = PathRace(hasRelay: true, hasDirect: true)
        #expect(race.relayReady() == .relay)
        #expect(race.directAnswered(url) == .relay)
    }

    @Test func relayIsUsedWhenDirectFails() {
        var race = PathRace(hasRelay: true, hasDirect: true)
        #expect(race.directFailedNow() == .undecided)  // still waiting for the handshake
        #expect(race.relayReady() == .relay)
    }

    @Test func directIsUsedWhenRelayFails() {
        var race = PathRace(hasRelay: true, hasDirect: true)
        #expect(race.relayFailedNow() == .undecided)
        #expect(race.directAnswered(url) == .direct(url))
    }

    @Test func bothFail() {
        var race = PathRace(hasRelay: true, hasDirect: true)
        #expect(race.relayFailedNow() == .undecided)
        #expect(race.directFailedNow() == .failed)
    }

    @Test func computerOfflineWaitsOnTheRelayUnlessDirectAnswers() {
        var a = PathRace(hasRelay: true, hasDirect: true)
        #expect(a.relayBridgeOffline() == .undecided)
        #expect(a.directAnswered(url) == .direct(url))

        var b = PathRace(hasRelay: true, hasDirect: true)
        #expect(b.relayBridgeOffline() == .undecided)
        #expect(b.directFailedNow() == .relay)  // stay on the relay and wait for bridge_online

        var c = PathRace(hasRelay: true, hasDirect: false)
        #expect(c.relayBridgeOffline() == .relay)
    }

    @Test func singlePathTargets() {
        var relayOnly = PathRace(hasRelay: true, hasDirect: false)
        #expect(relayOnly.relayReady() == .relay)
        var relayOnlyFails = PathRace(hasRelay: true, hasDirect: false)
        #expect(relayOnlyFails.relayFailedNow() == .failed)
        var directOnly = PathRace(hasRelay: false, hasDirect: true)
        #expect(directOnly.directAnswered(url) == .direct(url))
        var directOnlyFails = PathRace(hasRelay: false, hasDirect: true)
        #expect(directOnlyFails.directFailedNow() == .failed)
        #expect(PathRace(hasRelay: false, hasDirect: false).decision == .failed)
    }
}

struct RelayFramingTests {
    @Test func dataFramesRoundTrip() {
        let bytes = Data([0x00, 0xfb, 0xff, 0x10])
        let text = RelayFrame.encodeData(bytes)
        #expect(text == #"{"d":"APv_EA","t":"data"}"#)
        #expect(RelayFrame.decode(text) == .data(bytes))
    }

    @Test func controlFrames() {
        #expect(RelayFrame.decode(#"{"t":"bridge_offline"}"#) == .bridgeOffline)
        #expect(RelayFrame.decode(#"{"t":"bridge_online"}"#) == .bridgeOnline)
        #expect(RelayFrame.decode(#"{"t":"pong"}"#) == .pong)
        #expect(RelayFrame.ping == #"{"t":"ping"}"#)
        #expect(RelayTransport.pingInterval == 25 && RelayTransport.pongTimeout == 60)
        #expect(RelayFrame.decode(#"{"t":"something_new","x":1}"#) == .other("something_new"))
        #expect(RelayFrame.decode(#"{"t":"data","d":"!!"}"#) == nil)
        #expect(RelayFrame.decode(#"{"t":"data"}"#) == nil)
        #expect(RelayFrame.decode("not json") == nil)
        #expect(RelayFrame.decode(#"{"no_t":true}"#) == nil)
    }

    @Test func phoneSocketURL() {
        #expect(RelayAddress.phoneURL(base: "wss://earpiece-relay.me.workers.dev", bridgeID: "b1")?.absoluteString
                == "wss://earpiece-relay.me.workers.dev/v1/phone/b1")
        #expect(RelayAddress.phoneURL(base: "wss://relay.example/", bridgeID: "b1")?.absoluteString
                == "wss://relay.example/v1/phone/b1")
        #expect(RelayAddress.phoneURL(base: "https://relay.example/base", bridgeID: "b1")?.absoluteString
                == "wss://relay.example/base/v1/phone/b1")
        #expect(RelayAddress.phoneURL(base: "ws://127.0.0.1:8790", bridgeID: "6f1c2b7a-1111")?.absoluteString
                == "ws://127.0.0.1:8790/v1/phone/6f1c2b7a-1111")
        #expect(RelayAddress.phoneURL(base: "ftp://x", bridgeID: "b1") == nil)
        #expect(RelayAddress.phoneURL(base: "", bridgeID: "b1") == nil)
    }

    @Test func handshakePayloads() throws {
        let first = try #require(JSONSerialization.jsonObject(with: HandshakePayload.message1(phoneID: "p1", name: "iPhone", pairSecret: "s1")) as? NSDictionary)
        #expect(first == ["phone_id": "p1", "name": "iPhone", "pair_secret": "s1"] as NSDictionary)
        let later = try #require(JSONSerialization.jsonObject(with: HandshakePayload.message1(phoneID: "p1", name: "iPhone", pairSecret: nil)) as? NSDictionary)
        #expect(later == ["phone_id": "p1", "name": "iPhone"] as NSDictionary)

        #expect(HandshakePayload.reply(Data(#"{"ok":false,"reason":"not_paired"}"#.utf8))
                == HandshakePayload.Reply(ok: false, name: nil, bridgeID: nil, reason: "not_paired"))
        #expect(HandshakePayload.reply(Data("garbage".utf8)).ok == false)
    }

    @Test func helloOverTheRelayHasNoToken() throws {
        let text = try Wire.encode(.hello(token: nil, lastSeq: 4, client: "earpiece-ios/2.0"))
        let object = try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? NSDictionary)
        #expect(object == ["type": "hello", "last_seq": 4, "client": "earpiece-ios/2.0"] as NSDictionary)
        let data = try JSONEncoder().encode(ClientMessage.hello(token: nil, lastSeq: 4, client: "c"))
        #expect(try JSONDecoder().decode(ClientMessage.self, from: data) == .hello(token: nil, lastSeq: 4, client: "c"))
    }

    @Test func welcomeWithNullDriveIDDecodes() throws {
        // As in the bridge's vectors.
        let message = try Wire.decode(#"{"type":"welcome","drive_id":null,"cwd":"/Users/test","state":"idle","seq":0,"chat":null,"name":"Test Bridge","bridge_id":"00000000-0000-0000-0000-0000000000b1"}"#)
        #expect(message == .welcome(Welcome(driveID: "", cwd: "/Users/test", state: .idle, seq: 0, chat: .none,
                                            name: "Test Bridge", bridgeID: "00000000-0000-0000-0000-0000000000b1")))
    }
}
