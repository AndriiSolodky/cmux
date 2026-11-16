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

/// The `browser.page.*` ops of apps: the app's own page service (`BrowserPageService`, the
/// methods `cmux browser tab_… <verb>` runs) on a browser tab this app draws, named by `tab`
/// or, without one, the focused tab. The daemon has no CDP session for such a tab, so this is
/// how an extension reaches its page. The supervisor checked the scope (`browser:execute` for
/// `eval`, `browser:read` for `state`, `browser:write` for the rest) before it routed the call
/// here. Only the params each op documents pass: an app never names an agent's lease or a caller.
nonisolated struct BrowserPageAppOps: AppHostCapabilityHandler {
    let control: @Sendable (_ method: String, _ params: [String: JSONValue], _ callerApp: String) async throws(AppHostCapabilityError) -> JSONValue

    /// Each op and the params it takes besides `tab`.
    static let ops: [String: [String]] = [
        "browser.page.eval": ["script"], "browser.page.state": [], "browser.page.back": [], "browser.page.forward": [],
        "browser.page.reload": [], "browser.page.navigate": ["url"], "browser.page.new_tab": ["url"],
    ]

    var families: Set<String> { ["browser.page"] }

    func handle(_ request: AppHostCapabilityRequest) async throws(AppHostCapabilityError) -> AppJSON {
        guard let keys = Self.ops[request.op] else { throw .unsupported(request.op) }
        var params: [String: JSONValue] = [:]
        for key in keys + ["tab"] {
            if let value = request.params[key]?.stringValue { params[key] = .string(value) }
        }
        params["idempotency_key"] = request.idempotencyKey.map(JSONValue.string)
        return AppJSON(try await control(request.op, params, request.app))
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
