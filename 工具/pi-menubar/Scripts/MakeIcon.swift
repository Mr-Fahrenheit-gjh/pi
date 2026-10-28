import AppKit

// Render the official SVG as monochrome artwork using macOS, without a new dependency.
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
guard let artwork = NSImage(contentsOf: source) else { fatalError("Cannot read official Pi SVG") }
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for (side, name) in [(16, "icon_16x16"), (32, "icon_16x16@2x"), (32, "icon_32x32"),
                     (64, "icon_32x32@2x"), (128, "icon_128x128"), (256, "icon_128x128@2x"),
                     (256, "icon_256x256"), (512, "icon_256x256@2x"), (512, "icon_512x512"),
                     (1024, "icon_512x512@2x")] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let bounds = NSRect(x: 0, y: 0, width: side, height: side)
    artwork.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
    NSColor.black.setFill()
    bounds.fill(using: .sourceIn)
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name + ".png"))
}
