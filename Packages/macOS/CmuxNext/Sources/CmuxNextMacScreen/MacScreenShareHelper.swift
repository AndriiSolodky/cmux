import CmuxNextCompat
import CmuxNextComputerUse
import Foundation
import os

/// cmux Screen Share.app (screen-share design D9): the `cmux-rd` host in a helper bundle with its
/// own bundle id. The app starts it with responsibility disclaimed, so Screen Recording and
/// Accessibility granted to it belong to the helper: a grant takes effect at the helper's next
/// start with cmux left running, and a helper that crashes or is killed ends only its session.
///
/// It sits behind Share This Mac and changes nothing the person sees. When the helper has Screen
/// Recording, a session's `cmux rd serve` runs as the helper; otherwise it runs as today, as cmux's
/// own child under cmux's grants. Permission requests still go to cmux unless
/// `CMUX_NEXT_SCREEN_SHARE_HELPER=request` is set (dogfood and fleet checks), because asking for the
/// helper changes the name macOS shows in its prompt and in System Settings.
nonisolated final class MacScreenShareHelper: Sendable {
    /// `cmux-rd status --json` (cmux-rd-host helper_status.rs), the same shape as the Linux
    /// host's `linux-host status --json`.
    struct Status: Decodable, Equatable, Sendable {
        /// `granted`, `needs_grant`, `not_installed` or `unsupported`.
        var state: String
        var control: Bool
        var missing: [String]
        var helperVersion: String?

        static let notInstalled = Status(state: "not_installed", control: false, missing: [], helperVersion: nil)
        var granted: Bool { state == "granted" }
    }

    static let appName = "cmux Screen Share.app"
    static let executableName = "cmux-screen-share"

    private let embedded: @Sendable () -> URL?
    private let staging: HelperAppStaging
    private let logger = Logger(subsystem: "com.cmuxterm.app.next", category: "mac-screen-helper")
    private struct State {
        var executable: URL?
        var status: Status?
    }

    private let state = Mutex(State())

    init(embedded: @escaping @Sendable () -> URL? = { MacScreenShareHelper.embeddedApp() },
         staging: HelperAppStaging = HelperAppStaging(name: "screen-share")) {
        self.embedded = embedded
        self.staging = staging
    }

    /// `Contents/Library/cmux Screen Share.app` in this app, when it holds the helper's executable.
    static func embeddedApp(bundle: Bundle = .main) -> URL? {
        let url = bundle.bundleURL.appending(path: "Contents/Library/\(appName)", directoryHint: .isDirectory)
        return FileManager.default.fileExists(atPath: url.appending(path: "Contents/MacOS/\(executableName)").path) ? url : nil
    }

    /// Whether permission requests go to the helper (`CMUX_NEXT_SCREEN_SHARE_HELPER=request`).
    static var requestsGoToHelper: Bool {
        ProcessInfo.processInfo.environment["CMUX_NEXT_SCREEN_SHARE_HELPER"] == "request"
    }

    /// The last status read (nil before the first).
    var lastStatus: Status? { state.withLock { $0.status } }

    /// How a session's host starts now: as the helper when its last status had Screen Recording,
    /// else as cmux's child.
    var launch: MacScreenRdProcess.Launch {
        state.withLock { state in
            guard let executable = state.executable, state.status?.granted == true else { return .app }
            return .helper(executable)
        }
    }

    /// The staged copy's executable (copied out of this app once per helper build), or nil.
    @concurrent private func executable() async -> URL? {
        if let known = state.withLock({ $0.executable }) { return known }
        guard let source = embedded(), let copy = await staging.stage(source) else { return nil }
        let executable = copy.appending(path: "Contents/MacOS/\(Self.executableName)", directoryHint: .notDirectory)
        state.withLock { $0.executable = executable }
        return executable
    }

    /// Reads the helper's grants in a fresh helper process (a grant made a moment ago is read as it
    /// is now). `not_installed` when this app has no helper or its copy fails its signature check.
    @concurrent func refresh() async -> Status {
        await run(["status", "--json"])
    }

    /// The helper asks macOS for its own Screen Recording and Accessibility, then reports.
    @concurrent func requestPermissions() async -> Status {
        await run(["request-permissions"])
    }

    @concurrent private func run(_ arguments: [String]) async -> Status {
        guard let executable = await executable() else {
            state.withLock { $0.status = .notInstalled }
            return .notInstalled
        }
        let status: Status
        do {
            let process = try DisclaimedProcess.spawn(executable, arguments: arguments, environment: Self.environment())
            try? process.input.close()
            process.reapOnExit()
            status = try await Self.firstLine(process)
        } catch {
            logger.error("cmux Screen Share \(arguments.first ?? "", privacy: .public): \(String(describing: error), privacy: .public)")
            // A helper that does not answer is treated as not usable: sessions run as cmux's child.
            status = Status(state: "unsupported", control: false, missing: [], helperVersion: nil)
        }
        state.withLock { $0.status = status }
        return status
    }

    private struct NoAnswer: Error {}

    /// The helper's one status line; a helper that says nothing in 5 s is ended.
    @concurrent private static func firstLine(_ process: DisclaimedProcess) async throws -> Status {
        try await withThrowingTaskGroup(of: Status.self) { group in
            group.addTask {
                for try await line in process.output.bytes.lines {
                    if let status = try? JSONDecoder().decode(Status.self, from: Data(line.utf8)) { return status }
                }
                throw NoAnswer()
            }
            group.addTask {
                // The deadline of one helper answer; cancelled when it answers.
                try await Task.sleep(for: .seconds(5))
                process.terminate()
                throw NoAnswer()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw NoAnswer() }
            return first
        }
    }

    /// The helper's whole environment: nothing of this app's (which carries cmux tokens) but what
    /// a host session needs to find its home and temporary folder.
    static func environment(_ base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "RUST_LOG", "CMUX_RD_TIMING_LOG", "CMUX_RD_TRACE", "CMUX_RD_KEEP_AWAKE_MS"] {
            if let value = base[key] { environment[key] = value }
        }
        return environment
    }
}
