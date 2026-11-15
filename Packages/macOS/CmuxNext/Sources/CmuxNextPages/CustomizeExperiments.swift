public import CmuxNextSettings
public import Foundation

/// The pull requests whose pages are on in this app (`cmux customize use pr:N`): the `pr-N` entries of
/// the Customization Library that are on, as `cmux --json customize library list` lists them (an
/// entry's `code`, cmux-customize `library/code.rs`). The sidebar's "Experiment on · #N" mark shows
/// them and nothing while there are none (webviews `customizeLibrary.ts` `experimentsOn` counts the
/// same entries); its Turn Off runs `customize library off pr-N` for each, the CLI verb the
/// Customization Library card's switch runs, so the card and the mark never differ.
///
/// It reads the library again only when something can have changed it: at start, when
/// `web-dev.json` changes (``WebDevOverride/didChange``: the CLI points it at a PR's pages and back),
/// and after a library change the page or the mark ran (``SettingsCustomizeLibrary/didChange``). It
/// never polls. A read that fails keeps what it had.
@MainActor
public final class CustomizeExperiments {
    /// One PR entry that is on.
    public struct Experiment: Equatable, Sendable {
        /// The library entry's name, `pr-43543`.
        public let name: String
        public let repo: String
        public let pr: Int
        public let title: String
    }

    /// The PR entries that are on, top first.
    public private(set) var on: [Experiment] = []
    /// Each window's mark, with what draws it; a closed window's falls away with its owner.
    private var followers: [(owner: Weak, show: @MainActor ([Experiment]) -> Void)] = []

    private struct Weak { weak var object: AnyObject? }

    private let library: SettingsCustomizeLibrary
    private var reading: Task<Void, Never>?
    private var readAgain = false
    private var observers: [any NSObjectProtocol] = []

    public init(library: SettingsCustomizeLibrary) {
        self.library = library
    }

    /// Reads the library once and follows the changes that can turn a PR's pages on or off.
    public func start() {
        guard observers.isEmpty else { return }
        for name in [WebDevOverride.didChange, SettingsCustomizeLibrary.didChange] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            })
        }
        refresh()
    }

    /// Reads the library again; reads asked for while one runs coalesce into one more.
    public func refresh() {
        readAgain = true
        guard reading == nil else { return }
        reading = Task { [weak self] in // task-owner: the one read loop; asks while it runs coalesce
            while let self, self.readAgain {
                self.readAgain = false
                guard let answer = try? await self.library.answer(SettingsCustomizeLibrary.arguments(["verb": "list"])),
                      answer["library"]?["entries"] != nil else { continue }
                self.apply(Self.experiments(in: answer))
            }
            self?.reading = nil
        }
    }

    /// Calls `show` with ``on`` now and each time it changes, while `owner` lives (a window's mark).
    public func follow(_ owner: AnyObject, _ show: @escaping @MainActor ([Experiment]) -> Void) {
        followers.append((owner: Weak(object: owner), show: show))
        show(on)
    }

    private func apply(_ experiments: [Experiment]) {
        guard experiments != on else { return }
        on = experiments
        followers.removeAll { $0.owner.object == nil }
        for follower in followers { follower.show(experiments) }
    }

    /// Turns every PR entry that is on off, one CLI run each (the last one off puts back the app's own
    /// pages), then reads the library again. Answers the entries the CLI refused with its words.
    public func turnOffAll() async -> [(name: String, message: String)] {
        var refused: [(name: String, message: String)] = []
        for experiment in on {
            do {
                let answer = try await library.answer(SettingsCustomizeLibrary.arguments(["verb": "off", "name": .string(experiment.name)]))
                if answer["library"] == nil, let message = answer["message"]?.stringValue {
                    refused.append((experiment.name, message))
                }
            } catch {
                refused.append((experiment.name, String(describing: error)))
            }
        }
        refresh()
        return refused
    }

    /// The PR entries that are on in a `customize library` answer (`{"library": {"entries": …}}`), top first.
    nonisolated static func experiments(in answer: JSONValue) -> [Experiment] {
        (answer["library"]?["entries"]?.arrayValue ?? []).compactMap { entry in
            guard entry["on"]?.boolValue == true, let code = entry["code"], let name = entry["name"]?.stringValue,
                  let pr = code["pr"]?.intValue else { return nil }
            return Experiment(name: name, repo: code["repo"]?.stringValue ?? "", pr: pr, title: code["title"]?.stringValue ?? "")
        }
    }

    // MARK: Words

    /// The mark's line: "Experiment on · #43543" for one, "Experiments on · 3" for more; nil for none.
    public static func line(_ experiments: [Experiment]) -> String? {
        guard let first = experiments.first else { return nil }
        if experiments.count == 1 {
            return "\(text("customizeExperiments.mark.one", "Experiment on")) · #\(first.pr)"
        }
        return "\(text("customizeExperiments.mark.many", "Experiments on")) · \(experiments.count.formatted())"
    }

    /// The mark's tooltip: what it means and what a click does, then each PR's number and title.
    public static func help(_ experiments: [Experiment]) -> String {
        let lead = text("customizeExperiments.help",
                        "Some pages come from an unmerged pull request. Click to see it in the Customization Library.")
        let prs = experiments.map { $0.title.isEmpty ? "#\($0.pr)" : "#\($0.pr) \($0.title)" }
        return ([lead] + prs).joined(separator: "\n")
    }

    public static var turnOffTitle: String { text("customizeExperiments.turnOff", "Turn Off") }

    public static func turnOffFailed(_ name: String) -> String {
        String(format: text("customizeExperiments.turnOffFailed", "Couldn't turn off %@"), name)
    }

    /// Settings > Personalization at the Customization Library card.
    public static let libraryRoute = "#/settings/personalization?focus=card.customizeLibrary"

    private static func text(_ key: String.LocalizationValue, _ value: String.LocalizationValue) -> String {
        String(localized: key, defaultValue: value, bundle: .module)
    }
}
