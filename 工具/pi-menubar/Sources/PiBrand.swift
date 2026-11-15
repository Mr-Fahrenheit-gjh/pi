import AppKit

@MainActor
enum PiBrand {
    // Official artwork referenced by Pi's own README: https://pi.dev/logo-auto.svg
    // Keep the official geometry, but use a system template for consistent light/dark menu bars.
    static func icon(size: CGFloat = 18, badged: Bool = false, reserveBadge: Bool = false, resourceURL: URL? = nil) -> NSImage {
        let url = resourceURL ?? Bundle.main.url(forResource: "pi-logo", withExtension: "svg")
        guard let url, let artwork = NSImage(contentsOf: url) else {
            return NSImage(systemSymbolName: "app", accessibilityDescription: "Pi") ?? NSImage()
        }
        let image = NSImage(size: NSSize(width: size + (badged || reserveBadge ? 5 : 0), height: size), flipped: false) { bounds in
            artwork.draw(in: NSRect(x: 0, y: 0, width: size, height: size),
                         from: NSRect(x: 150, y: 150, width: 500, height: 500),
                         operation: .sourceOver, fraction: 1, respectFlipped: true,
                         hints: [.interpolation: NSImageInterpolation.high])
            NSColor.black.setFill()
            bounds.fill(using: .sourceIn)
            if badged {
                NSBezierPath(ovalIn: NSRect(x: size + 2, y: (size - 3) / 2, width: 3, height: 3)).fill()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Pi"
        return image
    }
}
