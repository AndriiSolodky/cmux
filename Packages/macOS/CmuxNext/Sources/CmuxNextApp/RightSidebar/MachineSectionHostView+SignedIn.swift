import CmuxNextActions
import CmuxNextAgentPane
import CmuxNextCompat
import CmuxNextDaemon
import CmuxNextServer

/// New Workspace on a joined Mac the app reaches only through the hub (cut 1 of the remote plan,
/// hq#11046). Leo, 2026-11-14, to option (a): on the new Mac, one click grants control to "your other
/// Macs signed in to this account"; signing in alone does not count as consent.
///
/// Over one person-proven acpmux line: the route acpmux keeps for that Mac (`_acpmux/machine_routes`),
/// then the probe (`_acpmux/machine_route_probe`), which that Mac answers from its person's consent and
/// which records its one ask there (its consent card shows it). Once it allows, the route's socket
/// becomes a server row's `unix` route (``ServerReachService/openSignedIn(daemonID:joinedID:socket:name:)``),
/// and the workspace opens on it once its session connects. The page asks again while that Mac's card
/// waits (webviews/src/pages/machines/store.ts); nothing here loops.
extension MachineSectionHostView {
    /// How long the route's session may take to connect after the probe passed.
    static let signedInConnectLimit: Duration = .seconds(20)

    static func openSignedIn(_ machine: JoinedMachine, services: AppServices) async -> JoinedDialAnswer {
        guard let environment = QuitAgents.environment(services),
              let line = await AcpmuxPersonLine.open(environment, deadline: .seconds(30)) else { return .unavailable("acpmux") }
        defer { line.close() }
        let routes = (await line.call("_acpmux/machine_routes", [:]))?["machines"] as? [[String: Any]] ?? []
        guard let route = machine.route(in: routes), let daemonID = route["daemonId"] as? String else {
            return .unavailable("machine.unlisted")
        }
        guard await line.call("_acpmux/machine_route_probe", ["daemonId": daemonID]) != nil else {
            return JoinedDialAnswer(refusal: line.lastErrorReason)
        }
        guard let socket = route["socket"] as? String,
              let machineID = services.serverReach.openSignedIn(daemonID: daemonID, joinedID: machine.id, socket: socket,
                                                                name: machine.name)
        else { return .unavailable("route.socket") }
        guard await connected(machineID, in: services.machines, within: signedInConnectLimit) else {
            return .unavailable("route.connect")
        }
        let ran = services.registry.perform("workspace.newOnMachine", invocation: ActionInvocation(arguments: ["machine": .string(machineID)]))
        return ran ? .opened : .unavailable("workspace")
    }

    /// Whether the session of `machineID` connects within `limit` (event-driven: its connection state).
    static func connected(_ machineID: String, in machines: MachineRegistry, within limit: Duration) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask { @MainActor in
                for await state in ObservationStream({ machines.daemon(machine: machineID)?.store.connectionState }) {
                    guard let state else { return false }
                    if case .connected = state { return true }
                }
                return false
            }
            group.addTask {
                try? await Task.sleep(for: limit)
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }
}
