import AppKit

/// Separate from the template image, so AppKit does not recolor yellow into black/white.
@MainActor
final class StatusAttentionDot: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemYellow.setFill()
        NSBezierPath(ovalIn: bounds).fill()
    }
    static func attach(to button: NSStatusBarButton) -> StatusAttentionDot {
        let dot = StatusAttentionDot(frame: .zero)
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.isHidden = true
        dot.setAccessibilityElement(false)
        button.addSubview(dot)
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 4), dot.heightAnchor.constraint(equalToConstant: 4),
            dot.centerXAnchor.constraint(equalTo: button.centerXAnchor, constant: 10),
            dot.centerYAnchor.constraint(equalTo: button.centerYAnchor)
        ])
        return dot
    }
}
