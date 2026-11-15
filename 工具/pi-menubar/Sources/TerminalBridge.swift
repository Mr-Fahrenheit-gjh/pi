import Foundation
import Darwin

struct TerminalOption: Decodable, Equatable {
    let label: String
    let description: String
    let hasPreview: Bool
}

struct TerminalQuestion: Decodable, Equatable {
    let question: String
    let header: String
    let multiSelect: Bool
    let options: [TerminalOption]
}

struct TerminalPrompt: Decodable, Equatable, Identifiable {
    let toolCallId: String
    let questions: [TerminalQuestion]?
    let unavailable: Bool?
    let canRespond: Bool
    var id: String { toolCallId }
    var hasPreview: Bool { questions?.contains { $0.options.contains { $0.hasPreview } } ?? false }
    var isRespondable: Bool { canRespond && questions != nil && !hasPreview }
}

struct TerminalSnapshot: Decodable, Equatable {
    let type: String
    let version: Int
    let instanceId: String
    let sessionId: String
    let title: String
    let project: String
    let prompts: [TerminalPrompt]

    func valid(for instance: UUID) -> Bool {
        guard type == "snapshot", version == 1, UUID(uuidString: instanceId) == instance,
              !sessionId.isEmpty, sessionId.count <= 200, title.count <= 1000, project.count <= 1000,
              prompts.count <= 32, Set(prompts.map(\.toolCallId)).count == prompts.count else { return false }
        return prompts.allSatisfy { prompt in
            guard !prompt.toolCallId.isEmpty, prompt.toolCallId.count <= 512 else { return false }
            guard let questions = prompt.questions else { return prompt.unavailable == true && !prompt.canRespond }
            return (1...4).contains(questions.count) && questions.allSatisfy { (2...4).contains($0.options.count) }
                && (!prompt.canRespond || !prompt.hasPreview)
        }
    }
}

struct TerminalTarget: Hashable {
    let instance: UUID
    let generation: UUID
    let sessionID: String
    let toolCallID: String
}

struct TerminalAnswer: Encodable, Equatable {
    let questionIndex: Int
    let optionIndexes: [Int]?
    let text: String?
}

enum TerminalAnswerValidator {
    static func valid(_ answers: [TerminalAnswer], questions: [TerminalQuestion]) -> Bool {
        guard answers.count == questions.count, Set(answers.map(\.questionIndex)).count == questions.count else { return false }
        return answers.allSatisfy { answer in
            guard questions.indices.contains(answer.questionIndex) else { return false }
            let question = questions[answer.questionIndex]
            let indexes = answer.optionIndexes ?? []
            guard Set(indexes).count == indexes.count, indexes.allSatisfy({ question.options.indices.contains($0) }) else { return false }
            if let text = answer.text, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
            guard !indexes.isEmpty || answer.text != nil else { return false }
            return question.multiSelect || (indexes.count <= 1 && (indexes.isEmpty || answer.text == nil))
        }
    }
}

enum TerminalSubmissionPhase: Equatable { case sending, accepted, rejected, uncertain }
struct TerminalSubmission {
    let requestID: String
    var phase: TerminalSubmissionPhase
}

struct TerminalAnswerMessage: Encodable {
    let type = "answer"
    let instanceId: String
    let sessionId: String
    let toolCallId: String
    let requestId: String
    let answers: [TerminalAnswer]?
    let cancel: Bool?
}

struct TerminalVerdict: Decodable {
    let type: String
    let requestId: String
    let toolCallId: String
    let ok: Bool
    let code: String?
}

struct TerminalSession: Identifiable {
    let snapshot: TerminalSnapshot
    let instance: UUID
    let generation: UUID
    var connected: Bool
    var id: String { "terminal:" + instance.uuidString.lowercased() }
}

enum TerminalBridgeEvent {
    case snapshot(TerminalSnapshot, UUID, UUID)
    case verdict(TerminalVerdict, UUID, UUID)
    case disconnected(UUID, UUID)
    case closed(UUID, UUID)
}

// Each connection reads on its own queue. Writes duplicate the descriptor before
// leaving the lock, so a disconnect cannot accidentally write to a reused fd.
private final class TerminalPeer {
    private let fd: Int32
    private let lock = NSLock()
    private var stopped = false
    private let onFrame: (Data) -> Void
    private let onClose: () -> Void
    private let writeQueue = DispatchQueue(label: "pi-menubar.terminal.write.\(UUID().uuidString)")

    init(fd: Int32, onFrame: @escaping (Data) -> Void, onClose: @escaping () -> Void) {
        self.fd = fd; self.onFrame = onFrame; self.onClose = onClose
    }

    func start() {
        DispatchQueue.global(qos: .utility).async { [self] in
            var buffer = Data()
            var bytes = [UInt8](repeating: 0, count: 8192)
            while true {
                let count = Darwin.read(fd, &bytes, bytes.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                buffer.append(contentsOf: bytes.prefix(count))
                if buffer.count > 5 * 1024 * 1024 { break }
                while let end = buffer.firstIndex(of: 10) {
                    let frame = Data(buffer[..<end])
                    buffer.removeSubrange(...end)
                    onFrame(frame)
                }
            }
            lock.lock(); stopped = true; lock.unlock()
            Darwin.close(fd)
            onClose()
        }
    }

    func send(_ data: Data) -> Bool {
        guard data.count <= 1024 * 1024 else { return false }
        lock.lock()
        let copy = stopped ? -1 : Darwin.dup(fd)
        lock.unlock()
        guard copy >= 0 else { return false }
        writeQueue.async { [self] in
            defer { Darwin.close(copy) }
            var timeout = timeval(tv_sec: 1, tv_usec: 0)
            _ = setsockopt(copy, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            let success = data.withUnsafeBytes { raw -> Bool in
                guard let base = raw.baseAddress else { return true }
                var offset = 0
                while offset < raw.count {
                    let count = Darwin.send(copy, base.advanced(by: offset), raw.count - offset, 0)
                    if count < 0 && errno == EINTR { continue }
                    if count <= 0 { return false }
                    offset += count
                }
                return true
            }
            if !success { stop() }
        }
        return true
    }

    func stop() {
        lock.lock()
        if !stopped { stopped = true; _ = Darwin.shutdown(fd, SHUT_RDWR) }
        lock.unlock()
    }
}

@MainActor
final class TerminalBridgeClient {
    private struct Header: Decodable { let type: String }
    private struct Closed: Decodable { let type: String; let version: Int; let instanceId: String; let sessionId: String }
    private struct PeerEntry { let peer: TerminalPeer; let generation: UUID; var sessionID: String? }
    private let directory: String
    private let onEvent: (TerminalBridgeEvent) -> Void
    private var peers: [UUID: PeerEntry] = [:]
    private var connecting = Set<UUID>()
    private var pollTask: Task<Void, Never>?
    private var epoch = UUID()

    init(directory: String = ProcessInfo.processInfo.environment["PI_MENUBAR_BRIDGE_DIR"] ?? "/tmp/pi-menubar-\(getuid())",
         onEvent: @escaping (TerminalBridgeEvent) -> Void) {
        self.directory = directory; self.onEvent = onEvent
    }

    func start() {
        guard pollTask == nil else { return }
        epoch = UUID()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.scan()
                do { try await Task.sleep(nanoseconds: 2_500_000_000) } catch { return }
            }
        }
    }

    func stop() {
        pollTask?.cancel(); pollTask = nil; epoch = UUID(); connecting.removeAll()
        let entries = peers
        peers.removeAll()
        for (instance, entry) in entries {
            entry.peer.stop()
            onEvent(.disconnected(instance, entry.generation))
        }
    }

    func send(_ message: TerminalAnswerMessage, target: TerminalTarget) -> Bool {
        guard let entry = peers[target.instance], entry.generation == target.generation,
              entry.sessionID == target.sessionID,
              let encoded = try? JSONEncoder().encode(message) else { return false }
        var frame = encoded; frame.append(10)
        return entry.peer.send(frame)
    }

    private func scan() {
        guard Self.isPrivateDirectory(directory),
              let names = try? FileManager.default.contentsOfDirectory(atPath: directory) else { return }
        for name in names where name.hasPrefix("t-") && name.hasSuffix(".sock") {
            let raw = String(name.dropFirst(2).dropLast(5))
            guard let instance = UUID(uuidString: raw), peers[instance] == nil, !connecting.contains(instance) else { continue }
            let socketPath = (directory as NSString).appendingPathComponent(name)
            guard Self.isPrivateSocket(socketPath) else { continue }
            connecting.insert(instance)
            let currentEpoch = epoch
            DispatchQueue.global(qos: .utility).async { [weak self] in
                let fd = Self.connectSocket(socketPath)
                DispatchQueue.main.async {
                    guard let self, self.epoch == currentEpoch, self.pollTask != nil else {
                        if fd >= 0 { Darwin.close(fd) }; return
                    }
                    self.connecting.remove(instance)
                    guard fd >= 0, self.peers[instance] == nil else {
                        if fd >= 0 { Darwin.close(fd) }; return
                    }
                    let generation = UUID()
                    let peer = TerminalPeer(fd: fd, onFrame: { [weak self] frame in
                        DispatchQueue.main.async { self?.receive(frame, instance: instance, generation: generation) }
                    }, onClose: { [weak self] in
                        DispatchQueue.main.async { self?.didDisconnect(instance: instance, generation: generation) }
                    })
                    self.peers[instance] = PeerEntry(peer: peer, generation: generation, sessionID: nil)
                    peer.start()
                }
            }
        }
    }

    private func receive(_ data: Data, instance: UUID, generation: UUID) {
        guard var entry = peers[instance], entry.generation == generation,
              let header = try? JSONDecoder().decode(Header.self, from: data) else { return }
        switch header.type {
        case "snapshot":
            guard let snapshot = try? JSONDecoder().decode(TerminalSnapshot.self, from: data), snapshot.valid(for: instance),
                  entry.sessionID == nil || entry.sessionID == snapshot.sessionId else { entry.peer.stop(); return }
            entry.sessionID = snapshot.sessionId; peers[instance] = entry
            onEvent(.snapshot(snapshot, instance, generation))
        case "verdict":
            guard entry.sessionID != nil, let verdict = try? JSONDecoder().decode(TerminalVerdict.self, from: data),
                  !verdict.requestId.isEmpty, verdict.requestId.count <= 200,
                  !verdict.toolCallId.isEmpty, verdict.toolCallId.count <= 512 else { entry.peer.stop(); return }
            onEvent(.verdict(verdict, instance, generation))
        case "session-closed":
            guard let closed = try? JSONDecoder().decode(Closed.self, from: data), closed.version == 1,
                  UUID(uuidString: closed.instanceId) == instance, closed.sessionId == entry.sessionID else { entry.peer.stop(); return }
            onEvent(.closed(instance, generation))
            peers.removeValue(forKey: instance)?.peer.stop()
        default: entry.peer.stop()
        }
    }

    private func didDisconnect(instance: UUID, generation: UUID) {
        guard let entry = peers[instance], entry.generation == generation else { return }
        peers.removeValue(forKey: instance)
        onEvent(.disconnected(instance, generation))
    }

    private nonisolated static func isPrivateDirectory(_ path: String) -> Bool {
        var info = stat()
        return lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == getuid() && (info.st_mode & 0o077) == 0
    }
    private nonisolated static func isPrivateSocket(_ path: String) -> Bool {
        var info = stat()
        return lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFSOCK && info.st_uid == getuid() && (info.st_mode & 0o077) == 0
    }
    private nonisolated static func connectSocket(_ path: String) -> Int32 {
        guard path.utf8.count < 104 else { return -1 }
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return -1 }
        var noSignal: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { Darwin.close(fd); return -1 }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let pathBytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { bytes in
            bytes.initializeMemory(as: UInt8.self, repeating: 0)
            bytes.copyBytes(from: pathBytes)
        }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        var user: uid_t = 0; var group: gid_t = 0
        guard result == 0, getpeereid(fd, &user, &group) == 0, user == getuid(),
              fcntl(fd, F_SETFL, flags) == 0 else { Darwin.close(fd); return -1 }
        return fd
    }
}
