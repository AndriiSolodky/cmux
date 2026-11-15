public import AppKit
import CmuxNextDesign

/// The "Experiment on · #43543" mark at the sidebar's bottom-left (webviews gallery
/// `ui.customize-experiments.mark`): it shows while an unmerged pull request's pages are on in this
/// app (`cmux customize use pr:N`, a `pr-N` entry of the Customization Library that is on) and
/// nothing otherwise. A click on it opens Settings > Personalization > Customization Library; its
/// Turn Off turns every such entry off through the bundled CLI, which puts back the app's own pages.
///
/// It is native on purpose: a PR's pages can break any page, Settings included, and the way out must
/// not be drawn by the experiment (Leo, 2026-11-14: "I want people to not accidentally soft lock
/// themselves and like have good recovery options"). It floats over the sidebar on its own chip like
/// app health's line (design/app-health.md), never in the footer row's flow, so its coming and going
/// moves nothing in the row (``SidebarFooterBand/placeExperimentsMark(above:)``). No motion.
@MainActor
public final class SidebarExperimentsMarkView: NSView {
    /// What the mark says: its line, its tooltip, and its button's title.
    public struct Shown: Equatable, Sendable {
        public var line: String
        public var help: String
        public var turnOff: String

        public init(line: String, help: String, turnOff: String) {
            self.line = line
            self.help = help
            self.turnOff = turnOff
        }
    }

    /// The press on the line (the App opens the Customization Library).
    public var onOpen: (() -> Void)?
    /// The press on Turn Off (the App turns every PR entry that is on off).
    public var onTurnOff: (() -> Void)?
    public private(set) var shown: Shown?

    /// The sidebar cards' veil and rim, never a solid fill (design/surface-materials.md `sidebar-card`).
    private let glass = CardSurfaceView()
    private let glyph = NSImageView()
    private let label = ChromeLabel(labelWithString: "")
    private let button = SidebarCardTextButton()
    static let glyphSide: CGFloat = 10

    override public init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        addSubview(glass)
        glyph.image = NSImage(systemSymbolName: "flask", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: Self.glyphSide, weight: .medium))
        glyph.setAccessibilityElement(false)
        addSubview(glyph)
        label.font = Typography.caption
        label.lineBreakMode = .byTruncatingTail
        label.setAccessibilityElement(false)
        addSubview(label)
        button.onPress = { [weak self] in self?.onTurnOff?() }
        button.setAccessibilityIdentifier("cmux.sidebar.experiments.turnOff")
        addSubview(button)
        isHidden = true
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityIdentifier("cmux.sidebar.experiments")
        applyColors()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// Shows `shown` (nil: no PR's pages are on; the mark hides and the sidebar lays out as before).
    public func show(_ shown: Shown?) {
        guard shown != self.shown else { return }
        self.shown = shown
        label.stringValue = shown?.line ?? ""
        themedToolTip = shown?.help
        setAccessibilityLabel(shown.map { "\($0.line). \($0.help)" })
        button.configure(title: shown?.turnOff ?? "", help: shown?.turnOff)
        isHidden = shown == nil
        superview?.needsLayout = true
    }

    private var inset: CGFloat { Metrics.space2 }

    override public var fittingSize: NSSize {
        let text = label.fittingSize
        let height = max(text.height + 2 * Metrics.space1, SidebarCardTextButton.height)
        return NSSize(width: inset + Self.glyphSide + Metrics.space1 + text.width + Metrics.space1 + button.fittingWidth + Metrics.space1,
                      height: height)
    }

    override public func layout() {
        super.layout()
        glass.frame = bounds
        glass.cornerRadius = Metrics.chipCornerRadius(height: bounds.height)
        let side = Self.glyphSide
        glyph.frame = NSRect(x: inset, y: (bounds.height - side) / 2, width: side, height: side)
        let buttonWidth = button.fittingWidth, buttonHeight = SidebarCardTextButton.height
        button.frame = NSRect(x: bounds.width - Metrics.space1 - buttonWidth, y: (bounds.height - buttonHeight) / 2,
                              width: buttonWidth, height: buttonHeight)
        let x = glyph.frame.maxX + Metrics.space1
        let height = label.fittingSize.height
        label.frame = NSRect(x: x, y: (bounds.height - height) / 2, width: max(0, button.frame.minX - Metrics.space1 - x), height: height)
    }

    override public func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColors()
    }

    private func applyColors() {
        performWithTheme {
            label.textColor = Palette.textSecondary
            glyph.contentTintColor = Palette.textSecondary
        }
    }

    /// Turn Off takes its own clicks; the rest of the chip is the line's. A hidden mark takes none.
    override public func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        return hit === button || hit.isDescendant(of: button) ? hit : self
    }

    override public var mouseDownCanMoveWindow: Bool { false }
    override public func mouseDown(with event: NSEvent) {}

    override public func mouseUp(with event: NSEvent) {
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onOpen?()
    }

    override public func accessibilityPerformPress() -> Bool {
        onOpen?()
        return onOpen != nil
    }
}
