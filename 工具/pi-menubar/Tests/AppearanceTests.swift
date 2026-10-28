import AppKit
import SwiftUI

@main struct AppearanceTests {
    @MainActor static func main() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let logoURL = URL(fileURLWithPath: "Resources/pi-logo.svg")
        let logo = PiBrand.icon(size: 180, resourceURL: logoURL)
        precondition(logo.isTemplate, "Use a system monochrome template")
        precondition(logo.size == NSSize(width: 180, height: 180))
        guard let tiff = logo.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Icon did not render") }
        var opaque = 0
        var isMonochrome = true
        for x in 0..<bitmap.pixelsWide {
            for y in 0..<bitmap.pixelsHigh {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), color.alphaComponent > 0.95 else { continue }
                opaque += 1
                isMonochrome = isMonochrome && abs(color.redComponent - color.greenComponent) < 0.01 && abs(color.greenComponent - color.blueComponent) < 0.01
            }
        }
        precondition(opaque > 5000, "Menu icon must contain visible artwork, not only SVG padding")
        precondition(isMonochrome, "Do not keep colored pixels in the menu icon")
        let badged = PiBrand.icon(badged: true, resourceURL: logoURL)
        precondition(badged.isTemplate && badged.size == NSSize(width: 23, height: 18), "Compact attention dot without text counters")
        try png.write(to: URL(fileURLWithPath: "build/pi-menu-icon-preview.png"))
        let panel = GlassPanel(content: Text("Pi 对话").padding())
        precondition(!panel.isOpaque && panel.backgroundColor == .clear)
        precondition(panel.frame.size == NSSize(width: 280, height: 454), "Stable 280×454 portrait menu, including a single session")
        precondition(!panel.hasShadow, "No rectangular window shadow outside native glass")
        precondition(PanelLayout.contentHeight == 406, "Keep a full-height scroll area instead of collapsing to a strip")
        let reserved = PiBrand.icon(reserveBadge: true, resourceURL: logoURL)
        precondition(reserved.isTemplate && reserved.size.width == 23, "Reserve dot space without tinting the logo")
        let dot = StatusAttentionDot(frame: NSRect(x: 0, y: 0, width: 4, height: 4))
        precondition(dot.hitTest(NSPoint(x: 2, y: 2)) == nil, "Yellow badge never intercepts menu clicks")
        let dotBitmap = dot.bitmapImageRepForCachingDisplay(in: dot.bounds)!
        dot.cacheDisplay(in: dot.bounds, to: dotBitmap)
        let yellow = dotBitmap.colorAt(x: 2, y: 2)!.usingColorSpace(.deviceRGB)!
        precondition(yellow.redComponent > 0.7 && yellow.greenComponent > 0.5 && yellow.blueComponent < 0.4, "Approval badge remains yellow, not template monochrome")
        let screen = NSRect(x: 0, y: 0, width: 1440, height: 900)
        let anchor = NSRect(x: 400, y: 900, width: 24, height: 22)
        let overview = PanelLayout.frame(anchor: anchor, available: screen)
        precondition(overview.minX == 392, "Expand right from the menu icon")
        precondition(overview.width == 280 && overview.height == 454, "Preserve the 1:1.62 silhouette")
        let edge = PanelLayout.frame(anchor: NSRect(x: 1400, y: 900, width: 24, height: 22), available: screen)
        precondition(edge.maxX == screen.maxX - 8 && screen.contains(edge), "Clamp only at the screen edge")
        let otherScreen = NSRect(x: -1440, y: 0, width: 1440, height: 900)
        let other = PanelLayout.frame(anchor: NSRect(x: -1000, y: 900, width: 24, height: 22), available: otherScreen)
        precondition(other.minX == -1008 && otherScreen.contains(other), "Respect secondary-screen coordinates")
        precondition(panel.canBecomeKey && !panel.canBecomeMain, "Panel must accept keyboard input")
        let surface = panel.contentView!
        let native: AnyClass? = NSClassFromString("NSGlassEffectView")
        let glass = native != nil ? surface.subviews.first! : surface
        if let native {
            precondition(surface.clipsToBounds && surface.layer?.masksToBounds == true && surface.layer?.shadowOpacity == 0,
                         "Clip the glass-owned halo, not only the NSWindow shadow")
            precondition(glass.isKind(of: native), "Use the actual OS Liquid Glass view")
            precondition((glass.value(forKey: "cornerRadius") as? CGFloat) == PanelLayout.cornerRadius)
            precondition(glass.value(forKey: "contentView") is NSView)
        } else { precondition(glass is NSVisualEffectView, "Older macOS uses native material fallback") }
        print("PASS: official monochrome template, yellow approval dot, fixed 280×454 panel, clipped native glass halo, rightward positioning and edge clamping, \(NSStringFromClass(type(of: glass)))")
    }
}
