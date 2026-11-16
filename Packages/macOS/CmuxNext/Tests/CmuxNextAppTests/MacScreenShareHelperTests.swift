import CmuxNextCompat
import CmuxNextComputerUse
@testable import CmuxNextMacScreen
import CmuxNextWakeups
import Foundation
import Testing

/// cmux Screen Share (screen-share D9): the host runs as its own helper process under its own
/// grants. These check the pieces a Mac can run without the helper bundle: the disclaimed spawn
/// that carries `cmux-rd serve`'s lines, the status line the Rust helper prints, and that the
/// app's permission rows count the helper's grants.
@MainActor @Suite
struct MacScreenShareHelperTests {
    /// The disclaimed spawn gives the child exactly its arguments and environment, carries stdin to
    /// stdout, and closing stdin ends it (the same liveness rule as `cmux rd serve` under Process).
    @Test func aDisclaimedChildEchoesStdinAndEndsAtEndOfFile() async throws {
        let child = try DisclaimedProcess.spawn(URL(fileURLWithPath: "/bin/sh"),
                                                arguments: ["-c", "echo \"$1:$MARK\"; cat", "sh", "argument"],
                                                environment: ["MARK": "env", "PATH": "/usr/bin:/bin"])
        let exit = AsyncStream.makeStream(of: Int32.self)
        child.reapOnExit { exit.continuation.yield($0); exit.continuation.finish() }
        try child.input.write(contentsOf: Data("line from the app\n".utf8))
        try child.input.close()
        var lines: [String] = []
        for try await line in child.output.bytes.lines { lines.append(line) }
        #expect(lines == ["argument:env", "line from the app"])
        var statuses = exit.stream.makeAsyncIterator()
        #expect(await statuses.next() == 0)
    }

    /// A child killed from outside ends its stdout: the session's line stream finishes, the app stays.
    @Test func aKilledChildEndsItsOutput() async throws {
        let child = try DisclaimedProcess.spawn(URL(fileURLWithPath: "/bin/sleep"), arguments: ["30"], environment: [:])
        child.reapOnExit()
        child.terminate()
        var count = 0
        for try await _ in child.output.bytes.lines { count += 1 }
        #expect(count == 0)
    }

    /// The Rust helper's `status --json` line (cmux-rd-host helper_status.rs) decodes as is.
    @Test func theHelperStatusLineDecodes() throws {
        let line = #"{"schema":"cmux.screen-share.status/1","platform":"macos","state":"granted","control":false,"display":{"capture":"screencapturekit","width":3024,"height":1964},"helperVersion":"0.2.3","missing":["accessibility"]}"#
        let status = try JSONDecoder().decode(MacScreenShareHelper.Status.self, from: Data(line.utf8))
        #expect(status.granted)
        #expect(!status.control)
        #expect(status.missing == ["accessibility"])
        #expect(status.helperVersion == "0.2.3")
    }

    /// Nothing of the app's environment but the listed names reaches the helper (the app's carries tokens).
    @Test func theHelperEnvironmentCarriesNoAppSecrets() {
        let environment = MacScreenShareHelper.environment(["HOME": "/Users/a", "CMUX_SOCKET_PASSWORD": "secret",
                                                            "CMUX_RD_TRACE": "1", "TMPDIR": "/tmp/x"])
        #expect(environment == ["HOME": "/Users/a", "CMUX_RD_TRACE": "1", "TMPDIR": "/tmp/x", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"])
    }

    /// With no helper in the bundle a session runs as today (cmux's child).
    @Test func withoutTheHelperSessionsRunAsTheAppsChild() async {
        let helper = MacScreenShareHelper(embedded: { nil })
        #expect(helper.launch == .app)
        #expect(await helper.refresh() == .notInstalled)
        #expect(helper.launch == .app)
    }

    /// A grant the helper holds shows as granted on Share This Mac, though cmux itself has none.
    @Test func theHelpersGrantCountsForSharing() async {
        let host = MacScreenShareHost(work: BackgroundWork())
        host.checkScreenRecording = { false }
        host.checkAccessibility = { false }
        host.checkHelper = { .init(state: "granted", control: true, missing: [], helperVersion: "0.2.3") }
        await host.refreshPermissions()
        #expect(host.screenRecordingGranted)
        #expect(host.accessibilityGranted)

        host.checkHelper = { .init(state: "needs_grant", control: false, missing: ["screen_recording", "accessibility"], helperVersion: "0.2.3") }
        await host.refreshPermissions()
        #expect(!host.screenRecordingGranted)
        #expect(!host.accessibilityGranted)
    }
}
