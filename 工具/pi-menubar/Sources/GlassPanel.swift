import AppKit
import SwiftUI

enum PanelLayout {
    static let width: CGFloat = 280
    static let headerHeight: CGFloat = 48
    static let maximumHeight: CGFloat = 454
    static let overviewSize = NSSize(width: width, height: maximumHeight) // Keep the 1:1.62 silhouette even for one session.
    static let cornerRadius: CGFloat = 16

    static let contentHeight = maximumHeight - headerHeight

    static func frame(anchor: NSRect, available: NSRect) -> NSRect {
        let preferred = overviewSize
        let size = NSSize(width: min(preferred.width, available.width - 24), height: min(preferred.height, available.height - 24))
        // Start under the menu-bar icon and grow rightward; only clamp at the screen edge.
        let x = max(available.minX + 8, min(anchor.minX - 8, available.maxX - size.width - 8))
        let y = max(available.minY + 8, min(anchor.minY - size.height - 8, available.maxY - size.height - 8))
        return NSRect(origin: NSPoint(x: x, y: y), size: size)
    }
}

/// A transparent panel avoids placing the native glass over NSPopover's opaque material.
@MainActor
final class GlassPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    var dismiss: (() -> Void)?

    init<Content: View>(content: Content) {
        super.init(contentRect: NSRect(origin: .zero, size: PanelLayout.overviewSize),
                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isFloatingPanel = true
        level = .floating
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        animationBehavior = .utilityWindow
        isReleasedWhenClosed = false
        let hosted = NSHostingView(rootView: content)
        hosted.frame = NSRect(origin: .zero, size: PanelLayout.overviewSize)
        hosted.autoresizingMask = [.width, .height]
        contentView = NativeGlass.wrap(hosted, cornerRadius: PanelLayout.cornerRadius)
    }

    override func cancelOperation(_ sender: Any?) { dismiss?() }
}

@MainActor
enum NativeGlass {
    static func wrap(_ content: NSView, cornerRadius: CGFloat) -> NSView {
        // Public AppKit API, introduced in macOS 26. This machine's SDK is 15.5:
        // resolve it at runtime rather than installing a new SDK or using a private blur API.
        // https://developer.apple.com/documentation/appkit/nsglasseffectview
        if let type = NSClassFromString("NSGlassEffectView") as? NSView.Type {
            let glass = type.init(frame: content.frame)
            if glass.responds(to: NSSelectorFromString("setContentView:")),
               glass.responds(to: NSSelectorFromString("setCornerRadius:")) {
                glass.setValue(cornerRadius, forKey: "cornerRadius")
                glass.setValue(content, forKey: "contentView")
                // Glass draws its own outside halo even when NSWindow.hasShadow is false.
                // Clip that native effect at the rounded panel boundary; retain the glass itself.
                let clip = NSView(frame: content.frame)
                clip.wantsLayer = true
                clip.clipsToBounds = true
                clip.layer?.cornerRadius = cornerRadius
                clip.layer?.masksToBounds = true
                clip.layer?.shadowOpacity = 0
                glass.autoresizingMask = [.width, .height]
                clip.addSubview(glass)
                return clip
            }
        }
        let material = NSVisualEffectView(frame: content.frame)
        material.material = .popover
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = cornerRadius
        material.layer?.masksToBounds = true
        material.addSubview(content)
        return material
    }
}
