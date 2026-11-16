import CmuxNextApps
import CmuxNextControl
import CmuxNextSettings
import Foundation

nonisolated extension ControlRouter {
    /// Runs one control method in process for a Mac-side app op (the
    /// CodeRouter app's and page's ops, `action.*`): validation, targets, the
    /// work queue and the origin rule are the control socket's.
    func appControl(_ method: String, _ params: [String: JSONValue], callerApp: String? = nil) async throws(AppHostCapabilityError) -> JSONValue {
        switch await handle(ControlRequest(method: method, params: params, callerApp: callerApp), connection: .inProcess) {
        case .success(let value): return value
        case .failure(let error):
            throw AppHostCapabilityError(code: error.code, message: error.message, details: error.data.map(AppJSON.init))
        }
    }
}

/// The `action.*` ops of apps (`action.run`, `action.list`), mapped onto the
/// control methods with the app call's origin (`user` inside a gesture, else
/// `script`). The supervisor already checked the scope, the action's agent
/// surface and the view-state token before it routed the call here.
/// The original mutation key reaches the shared action router unchanged;
/// operation params cannot replace it or the supervisor's origin.
nonisolated struct ActionAppOps: AppHostCapabilityHandler {
    let control: @Sendable (_ method: String, _ params: [String: JSONValue], _ callerApp: String) async throws(AppHostCapabilityError) -> JSONValue

    var families: Set<String> { ["action"] }

    func handle(_ request: AppHostCapabilityRequest) async throws(AppHostCapabilityError) -> AppJSON {
        let origin = JSONValue.string(request.origin)
        switch request.op {
        case "action.run":
            guard let id = request.params["id"]?.stringValue else { throw AppHostCapabilityError(code: "invalid_params", message: "action.run needs id") }
            var params: [String: JSONValue] = ["action": .string(id), "args": (request.params["args"] ?? .object([:])).settingsValue, "origin": origin]
            params["idempotency_key"] = request.idempotencyKey.map(JSONValue.string)
            return AppJSON(try await control("action.run", params, request.app))
        case "action.list":
            return AppJSON(try await control("action.list", ["origin": origin], request.app))
        default:
            throw .unsupported(request.op)
        }
    }
}

/// `browser.page.eval {script, tab?}` for apps (`browserPage.eval` in cmux-extension-sdk): runs
/// `script` in the page of a browser tab this app draws, the named tab or else the focused one, and
/// answers `{tab, value}`. It is the control socket's `browser.page.eval`, so the tab rule, the
/// JSON-safe wrapper and the errors are the CLI's. The supervisor already checked the app's
/// `browser.page:control` grant (a sensitive scope the person accepts on the consent sheet when they
/// turn the extension on). An app names only `script` and `tab`: it cannot pose as an agent driver.
nonisolated struct BrowserPageAppOps: AppHostCapabilityHandler {
    let control: @Sendable (_ method: String, _ params: [String: JSONValue], _ callerApp: String) async throws(AppHostCapabilityError) -> JSONValue

    /// The largest script an app may send (the provider channel caps params at 64 KiB).
    static let maxScript = 60_000

    var families: Set<String> { ["browser.page"] }

    func handle(_ request: AppHostCapabilityRequest) async throws(AppHostCapabilityError) -> AppJSON {
        guard request.op == "browser.page.eval" else { throw .unsupported(request.op) }
        guard let script = request.params["script"]?.stringValue, !script.isEmpty else {
            throw AppHostCapabilityError(code: "invalid_params", message: "browser.page.eval needs a script")
        }
        guard script.utf8.count <= Self.maxScript else {
            throw AppHostCapabilityError(code: "invalid_params", message: "a page script is at most \(Self.maxScript) bytes")
        }
        var params: [String: JSONValue] = ["script": .string(script)]
        if let tab = request.params["tab"]?.stringValue, !tab.isEmpty { params["tab"] = .string(tab) }
        return AppJSON(try await control("browser.page.eval", params, request.app))
    }
}
