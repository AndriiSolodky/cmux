#if DEBUG
import AppKit
import CmuxNextActions
import CmuxNextDesignTokens
import CmuxNextPages
import CmuxNextServer
import CmuxNextSettings
import CmuxNextSidebar

/// The Machines page on top of the showcase window, opened from the sidebar's Machines item: this Mac,
/// the sample Cloud, SSH and server machines (`machines.section.fixture`) and the joined machines
/// (`JoinedMachine.fixtures`), with the joined Mac studio-mini's controls shown (its New Workspace and "…").
extension CaptureSceneRegistry {
    static let machinesPageScene = "machines-page"

    func renderMachinesPage(_ params: [String: CmuxNextSettings.JSONValue], definition: CaptureSceneDefinition,
                            windowID: String) async -> CmuxNextSettings.JSONValue {
        guard let controller = services.windows.controller(for: windowID) else {
            return .object(["error": .string("no window for the Machines page"), "scene": .string(definition.name)])
        }
        controller.sidebar.restore(width: 300, hidden: false)
        _ = DebugTunables.handle(["action": .string("set"), "key": .string(ServerTunables.machinesFixture.key), "value": .bool(true)],
                                 services: services)
        let joined = JoinedMachine.fixtures
        services.debugFixtures.joinedMachines = MachineJoinService(mint: { _ in .failure(.unavailable) }, list: { joined })
        services.joinedMachines.apply(joined)
        // The row's controls show while its menu is open, as on hover: the Mac signed in to this account.
        services.joinedMachines.openMenu = joined.first { $0.platform == "macos" && $0.state == .online }?.id
        // The page opens as the sidebar's Machines item opens it (Add to Sidebar, as the App Store's card does).
        let item = controller.sidebar.model.layout.firstItem(with: .builtIn(.machines)) != nil
            || services.registry.perform("sidebar.item.add", invocation: ActionInvocation(arguments: ["item": .string(SidebarBuiltIn.machines.rawValue)]))
        guard TopPages.show(.page(.machines), services: services, in: controller.state) != nil else {
            return .object(["error": .string("the Machines page did not open"), "scene": .string(definition.name)])
        }
        frames.start()
        let settled = await frames.settled(until: { [self] in machinesPageShown(windowID: windowID) },
                                           start: ContinuousClock.now, window: 600, deadline: 10_000)
        let frameStats = frames.stop()
        guard settled != nil else {
            return .object(["error": .string("the Machines page never showed"), "scene": .string(definition.name), "frames": frameStats])
        }
        var snapshotParams = params
        snapshotParams["window"] = .string(windowID)
        let snapshot = await DebugWindowSnapshot.captureAsync(snapshotParams, services: services)
        guard case .object(var result) = snapshot else { return snapshot }
        result["scene"] = .string(definition.name)
        result["description"] = .string(definition.description)
        result["settled_ms"] = settled.map(CmuxNextSettings.JSONValue.number) ?? .null
        result["frames"] = frameStats
        result["sidebar_item"] = .bool(item)
        result["joined"] = .number(Double(joined.count))
        return .object(result)
    }

    /// The window shows the Machines page and its section host is on screen.
    func machinesPageShown(windowID: String) -> Bool {
        guard let controller = services.windows.controller(for: windowID), controller.state.page == .page(.machines),
              let page = controller.topPages.view(for: .page(.machines), in: controller) as? InternalPageView else { return false }
        return Self.sectionHost(in: page)?.isShown == true
    }

    /// The Machines page's `PageSectionHost` under `view`.
    static func sectionHost(in view: NSView) -> PageSectionHost? {
        if let host = view as? PageSectionHost { return host }
        for child in view.subviews { if let host = sectionHost(in: child) { return host } }
        return nil
    }
}
#endif
