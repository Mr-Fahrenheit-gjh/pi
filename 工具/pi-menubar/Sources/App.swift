import AppKit
import SwiftUI
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var statusItem: NSStatusItem!
    private var panel: GlassPanel!
    private var outsideClickMonitor: Any?
    private var store: PiStore!
    private var browser: ChromeBrowserController!
    private var attentionDot: StatusAttentionDot?
    private var workspaceObservers: [NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        let endpoint: PiEndpoint
        do { endpoint = try PiEndpoint(ProcessInfo.processInfo.environment["PI_MENUBAR_URL"] ?? "http://127.0.0.1:30141") }
        catch { fputs("PI_MENUBAR_URL must be a local HTTP origin\n", stderr); NSApp.terminate(nil); return }
        browser = ChromeBrowserController(endpoint: endpoint)
        let checkBrowser = CommandLine.arguments.contains("--check-browser")
        let focusExisting = CommandLine.arguments.contains("--focus-existing")
        if checkBrowser || focusExisting {
            Task {
                let trace: (String) -> Void = { NSLog("PiBrowserCheck %@", $0) }
                if CommandLine.arguments.contains("--prewarm") {
                    browser.prewarm(trace: trace)
                    await browser.finishPrewarm()
                }
                let started = ProcessInfo.processInfo.systemUptime
                do {
                    // Explicit focus mode exercises the normal native activation path without
                    // changing a session URL, opening a tab, or requesting a new permission.
                    try await browser.open(sessionID: nil, verifyOnly: checkBrowser, requestPermission: false, trace: trace)
                    trace(checkBrowser ? "PASS: read-only native Chrome lookup and condition check; no tab changed"
                                       : "PASS: existing Pi tab focused; no URL changed")
                    trace(String(format: "Native completion: %.0f ms", (ProcessInfo.processInfo.systemUptime - started) * 1000))
                } catch { trace("FAIL: \(error.localizedDescription)") }
                NSApp.terminate(nil)
            }
            return
        }
        store = PiStore(endpoint: endpoint)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = "PiConversations"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(toggle)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        statusItem.button?.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        statusItem.button?.image = PiBrand.icon()
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.setAccessibilityLabel("Pi 对话：进行中、待审批和未读")
        if let button = statusItem.button { attentionDot = StatusAttentionDot.attach(to: button) }
        panel = GlassPanel(content: MenuView(store: store, openBrowser: { [weak self] id in self?.openBrowser(id) }))
        panel.dismiss = { [weak self] in self?.hide() }
        store.onChange = { [weak self] in self?.updateStatus() }
        installEditMenu()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([UNNotificationCategory(identifier: "PI_APPROVAL", actions: [
            UNNotificationAction(identifier: "OPEN", title: "在菜单栏处理", options: [.foreground])
        ], intentIdentifiers: [])])
        let workspace = NSWorkspace.shared.notificationCenter
        workspaceObservers = [
            workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.store.suspend() }
            },
            workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.store.resume() }
            }
        ]
        updateStatus()
        store.start()
        if CommandLine.arguments.contains("--show") { show(nil) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        show(nil); return false
    }
    func applicationDidResignActive(_ notification: Notification) {
        if panel?.attachedSheet == nil { hide() }
    }
    func applicationWillTerminate(_ notification: Notification) {
        store?.stop()
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        if let monitor = outsideClickMonitor { NSEvent.removeMonitor(monitor) }
    }

    private func updateStatus() {
        statusItem.button?.title = ""
        let awaiting = store.awaitingCount > 0
        statusItem.button?.image = PiBrand.icon(badged: !awaiting && !store.unread.isEmpty, reserveBadge: awaiting)
        attentionDot?.isHidden = !awaiting
        let status = "进行中 \(store.active.count) · 待审批 \(store.awaitingCount) · 未读 \(store.unread.count)"
        statusItem.button?.toolTip = "Pi · " + status + (store.connected ? "" : " · Web 未连接")
        statusItem.button?.setAccessibilityValue(status)
        let screen = statusItem.button?.window?.screen ?? NSScreen.main
        let available = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        guard let button = statusItem.button, let window = button.window else { return }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        panel.setFrame(PanelLayout.frame(anchor: anchor, available: available), display: panel.isVisible)
    }

    private func installEditMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 Pi 菜单栏", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"),
                                     ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }

    @objc private func toggle() {
        if NSApp.currentEvent?.type == .rightMouseUp, let button = statusItem.button {
            hide()
            let menu = NSMenu()
            menu.addItem(withTitle: "退出 Pi 菜单栏", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            statusItem.menu = menu
            button.performClick(nil)
            statusItem.menu = nil
            return
        }
        if panel.isVisible { hide() } else { show(nil) }
    }
    private func show(_ sessionID: String?) {
        if let sessionID { store.category = .awaiting; store.focusedSessionID = sessionID }
        updateStatus()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(nil)
        statusItem.button?.highlight(true)
        if outsideClickMonitor == nil {
            outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                Task { @MainActor in
                    if self?.panel.attachedSheet == nil { self?.hide() }
                }
            }
        }
        browser.prewarm()
        Task { await store.updateNotificationPermission(request: false); await store.refresh() }
    }
    private func hide() {
        panel?.orderOut(nil)
        statusItem?.button?.highlight(false)
        if let monitor = outsideClickMonitor {
            NSEvent.removeMonitor(monitor)
            outsideClickMonitor = nil
        }
    }
    private func openBrowser(_ sessionID: String?) {
        guard !store.navigating else { return }
        store.navigating = true
        store.navigationError = nil
        let readTarget = sessionID.flatMap { store.readTarget(for: $0) }
        Task { [weak self] in
            guard let self else { return }
            defer { self.store.navigating = false }
            do {
                try await self.browser.open(sessionID: sessionID)
                if let readTarget { self.store.markRead(readTarget) }
                self.hide()
            } catch {
                self.store.navigationError = error.localizedDescription
                self.show(nil)
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["sessionId"] as? String
        Task { @MainActor [weak self] in
            self?.show(id)
            completionHandler()
        }
    }
}

@main
struct PiMenuBarMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
