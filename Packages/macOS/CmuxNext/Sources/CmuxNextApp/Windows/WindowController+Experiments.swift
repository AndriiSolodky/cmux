import AppKit
import CmuxNextDesign
import CmuxNextPages
import CmuxNextSidebar

extension WindowController {
    /// The sidebar's "Experiment on · #N" mark (SidebarExperimentsMarkView): shown while a pull
    /// request's pages are on in this app (`cmux customize use pr:N`), nothing otherwise. A click opens
    /// Settings > Personalization > Customization Library; Turn Off runs `customize library off pr-N`
    /// for each through the bundled CLI, from this native view, so a PR whose pages broke Settings
    /// still has a way out (Leo, 2026-11-14: "I want people to not accidentally soft lock themselves
    /// and like have good recovery options"). A refusal shows the CLI's words in a toast.
    func makeExperimentsMark() -> SidebarExperimentsMarkView {
        let mark = SidebarExperimentsMarkView()
        let experiments = services.customizeExperiments
        mark.onOpen = { [weak services = services] in
            try? services?.settingsWindow.show(section: nil, focus: true, route: CustomizeExperiments.libraryRoute)
        }
        mark.onTurnOff = { [weak self, weak experiments] in
            guard let experiments else { return }
            Task { @MainActor [weak self] in // task-owner: one turn-off run per click, bounded by the CLI's deadline
                let refused = await experiments.turnOffAll()
                guard let first = refused.first, let window = self?.window else { return }
                let toast = CmuxToast(id: "customize-experiments", message: CustomizeExperiments.turnOffFailed(first.name),
                                      detail: first.message, tone: .error)
                _ = CmuxToastCenter.shared.show(toast, in: window)
            }
        }
        experiments.follow(mark) { [weak mark] on in
            mark?.show(CustomizeExperiments.line(on).map {
                SidebarExperimentsMarkView.Shown(line: $0, help: CustomizeExperiments.help(on), turnOff: CustomizeExperiments.turnOffTitle)
            })
        }
        return mark
    }
}
