// SPDX-License-Identifier: GPL-3.0-or-later
public import Darwin
public import Foundation
import CmuxNextCompat

/// A helper process started with macOS responsibility disclaimed, so it is its own
/// responsible process: Screen Recording and Accessibility are checked against the
/// helper's code identity, never against cmux (`DisclaimedHelperSpawner` explains why).
/// Unlike the Computer Use helper's spawner it takes arguments and gives the caller all
/// three pipes, so a JSON-lines child (`cmux-rd serve` in cmux Screen Share.app) runs
/// through it exactly as it runs through `Process`.
///
/// The child stays this app's child: closing `input` (stop, quit or crash of this app)
/// is its end of file. `reapOnExit` reaps it off the main thread.
public nonisolated final class DisclaimedProcess: Sendable {
    public enum Failure: Error, Equatable {
        /// libsystem has no `responsibility_spawnattrs_setdisclaim`: starting the helper
        /// anyway would make macOS attribute its permissions to cmux.
        case disclaimUnavailable
        case spawn(Int32)
    }

    public let pid: pid_t
    /// The write end of the child's stdin.
    public let input: FileHandle
    /// The read ends of the child's stdout and stderr.
    public let output: FileHandle
    public let errorOutput: FileHandle

    private init(pid: pid_t, input: FileHandle, output: FileHandle, errorOutput: FileHandle) {
        self.pid = pid
        self.input = input
        self.output = output
        self.errorOutput = errorOutput
    }

    /// Starts `executable` with `arguments` (argv[0] is the executable's path) and exactly
    /// `environment`: nothing of this app's environment, which carries cmux tokens, is passed on.
    public static func spawn(_ executable: URL, arguments: [String], environment: [String: String]) throws -> DisclaimedProcess {
        try spawn(executable, arguments: arguments, environment: environment, disclaim: DisclaimedHelperSpawner.systemDisclaim)
    }

    static func spawn(_ executable: URL, arguments: [String], environment: [String: String],
                      disclaim: DisclaimedHelperSpawner.DisclaimFunction?) throws -> DisclaimedProcess {
        guard let disclaim else { throw Failure.disclaimUnavailable }
        // [read, write] per pipe: stdin is written here, stdout and stderr are read here.
        var pipes: [[Int32]] = [[-1, -1], [-1, -1], [-1, -1]]
        for index in pipes.indices {
            guard pipe(&pipes[index]) == 0 else {
                let error = errno
                pipes.flatMap { $0 }.filter { $0 >= 0 }.forEach { close($0) }
                throw Failure.spawn(error)
            }
        }
        let ours = [pipes[0][1], pipes[1][0], pipes[2][0]]
        let theirs = [pipes[0][0], pipes[1][1], pipes[2][1]]
        for descriptor in ours { _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC) }
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        posix_spawn_file_actions_init(&actions)
        posix_spawnattr_init(&attributes)
        defer {
            posix_spawn_file_actions_destroy(&actions)
            posix_spawnattr_destroy(&attributes)
            theirs.forEach { close($0) }
        }
        posix_spawn_file_actions_adddup2(&actions, theirs[0], STDIN_FILENO)
        posix_spawn_file_actions_adddup2(&actions, theirs[1], STDOUT_FILENO)
        posix_spawn_file_actions_adddup2(&actions, theirs[2], STDERR_FILENO)
        // Only stdin, stdout and stderr reach the helper.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
        guard disclaim(&attributes, 1) == 0 else {
            ours.forEach { close($0) }
            throw Failure.disclaimUnavailable
        }
        let argv: [UnsafeMutablePointer<CChar>?] = ([executable.path] + arguments).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = environment.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var pid: pid_t = 0
        let status = posix_spawn(&pid, executable.path, &actions, &attributes, argv, envp)
        guard status == 0 else {
            ours.forEach { close($0) }
            throw Failure.spawn(status)
        }
        return DisclaimedProcess(pid: pid,
                                 input: FileHandle(fileDescriptor: ours[0], closeOnDealloc: true),
                                 output: FileHandle(fileDescriptor: ours[1], closeOnDealloc: true),
                                 errorOutput: FileHandle(fileDescriptor: ours[2], closeOnDealloc: true))
    }

    /// Reaps the child when it exits, on its own thread, then calls `onExit` with its wait status
    /// there; the child never stays a zombie.
    public func reapOnExit(_ onExit: @escaping @Sendable (Int32) -> Void = { _ in }) {
        let pid = pid
        let thread = Thread {
            var status: Int32 = 0
            // concurrency-allow: waitpid blocks on this dedicated reaper Thread, never the main actor.
            while waitpid(pid, &status, 0) < 0, errno == EINTR {}
            onExit(status)
        }
        thread.name = "disclaimed-helper-reap"
        thread.start()
    }

    /// SIGTERM to this exact pid (it is ours and not yet reaped while `reapOnExit` waits).
    public func terminate() {
        guard pid > 0 else { return }
        kill(pid, SIGTERM)
    }
}

/// A signed helper app copied out of this app's bundle before it runs
/// (`ComputerUseHelperStaging` explains why: macOS 26 checks Screen Recording of a nested
/// helper as the outer app). For helpers other than Computer Use: cmux Screen Share.
public nonisolated struct HelperAppStaging: Sendable {
    private let staging: ComputerUseHelperStaging

    /// The copy goes beside the Computer Use helper's, in the same private, checked folder:
    /// `<cmux-cua root>/helper/next-<name>-<scope of this app>/`, verified against the source's
    /// own designated requirement. The `next-` prefix keeps classic cmux's installer away.
    public init(name: String, bundleID: String = Bundle.main.bundleIdentifier ?? "com.cmuxterm.app",
                home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        let operations = ComputerUseHelperStaging.Operations.system(
            verify: { copy, source in ComputerUseHelperStaging.satisfiesDesignatedRequirement(copy, of: source) },
            requirement: { ComputerUseHelperStaging.designatedRequirementOf($0) })
        let folder = ComputerUseHelperStaging.root(home: home)
            .appending(path: "next-\(name)-\(ComputerUseHelperDaemon.scope(bundleID))", directoryHint: .isDirectory)
        staging = ComputerUseHelperStaging(folder: folder, home: home, operations: operations)
    }

    /// The verified copy of `source` to launch (reused while it matches), or nil.
    @concurrent public func stage(_ source: URL) async -> URL? {
        await staging.stage(source)
    }
}
