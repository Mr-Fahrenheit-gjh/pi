import Foundation

/// Only the Pi auth cookie from this app's own cookie store is eligible.
/// Cookies have no port scope; the client still sends them only to its pinned endpoint.
enum PiCookies {
    static func applicable(_ cookies: [HTTPCookie], to url: URL, now: Date = Date()) -> [HTTPCookie] {
        cookies.filter { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            let path = url.path.isEmpty ? "/" : url.path
            let matchesPath = path == cookie.path || (path.hasPrefix(cookie.path) &&
                (cookie.path.hasSuffix("/") || path.dropFirst(cookie.path.count).hasPrefix("/")))
            return cookie.name == "pi_web_session" && domain == url.host && matchesPath &&
                (!cookie.isSecure || url.scheme == "https") && (cookie.expiresDate.map { $0 > now } ?? true)
        }
    }
}

final class LoopbackRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let endpoint: PiEndpoint
    init(endpoint: PiEndpoint) { self.endpoint = endpoint }

    func allows(method: String?, destination: URL?) -> Bool {
        method != "POST" && destination.map(endpoint.contains) == true
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(allows(method: task.originalRequest?.httpMethod, destination: request.url) ? request : nil)
    }
}
