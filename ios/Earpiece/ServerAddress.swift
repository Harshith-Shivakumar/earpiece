import Foundation

/// Turns what the user typed into a WebSocket URL, and derives the /health URL from it.
enum ServerAddress {
    static let defaultPort = 8787

    /// Accepts "ws://host:8787/ws", "wss://...", "http(s)://..." or a bare "host[:port]".
    /// Adds "/ws" when there is no path, and port 8787 for plain ws:// without a port.
    static func webSocketURL(from raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let lower = text.lowercased()
        if lower.hasPrefix("http://") {
            text = "ws://" + text.dropFirst("http://".count)
        } else if lower.hasPrefix("https://") {
            text = "wss://" + text.dropFirst("https://".count)
        } else if !lower.contains("://") {
            text = "ws://" + text
        }
        guard var comps = URLComponents(string: text),
              let scheme = comps.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              let host = comps.host, !host.isEmpty
        else { return nil }
        comps.scheme = scheme
        if comps.path.isEmpty || comps.path == "/" { comps.path = "/ws" }
        if scheme == "ws" && comps.port == nil { comps.port = defaultPort }
        return comps.url
    }

    /// Tailscale addresses: 100.64.0.0/10 (CGNAT range) or a MagicDNS name under .ts.net.
    static func isTailscaleHost(_ host: String) -> Bool {
        let lower = host.lowercased()
        if lower.hasSuffix(".ts.net") || lower.hasSuffix(".ts.net.") { return true }
        let parts = lower.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, lower.split(separator: ".").count == 4, parts[0] == 100 else { return false }
        return (64...127).contains(parts[1])
    }

    static func healthURL(from webSocketURL: URL) -> URL? {
        guard var comps = URLComponents(url: webSocketURL, resolvingAgainstBaseURL: false) else { return nil }
        comps.scheme = (comps.scheme?.lowercased() == "wss") ? "https" : "http"
        comps.path = "/health"
        comps.query = nil
        return comps.url
    }
}
