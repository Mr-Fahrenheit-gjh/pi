#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" \
  Sources/SessionState.swift Sources/ApprovalState.swift Sources/PiTransport.swift Sources/TerminalBridge.swift Sources/PiStore.swift \
  Tests/TerminalBridgeTests.swift -o build/terminal-bridge-tests \
  -framework AppKit -framework SwiftUI -framework WebKit -framework UserNotifications
# The Node cross-process test launches terminal-bridge-tests as the menu-bar client.
node --test Tests/terminal-bridge.test.mjs Tests/terminal-cross-process.test.mjs
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" \
  Sources/SessionState.swift Tests/StateTests.swift -o build/state-tests
build/state-tests
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" \
  Sources/SessionState.swift Sources/ApprovalState.swift Sources/PiTransport.swift Tests/ApprovalTests.swift -o build/approval-tests
build/approval-tests
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" \
  Sources/SessionState.swift Sources/ApprovalState.swift Sources/PiTransport.swift Sources/TerminalBridge.swift Sources/PiStore.swift Tests/StoreTests.swift \
  -o build/store-tests -framework AppKit -framework SwiftUI -framework WebKit -framework UserNotifications
build/store-tests
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" \
  Sources/SessionState.swift Sources/ApprovalState.swift Sources/PiTransport.swift Sources/TerminalBridge.swift Sources/PiStore.swift Tests/TerminalStoreTests.swift \
  -o build/terminal-store-tests -framework AppKit -framework SwiftUI -framework WebKit -framework UserNotifications
build/terminal-store-tests
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" \
  Sources/SessionState.swift Sources/ChromeTabNavigator.swift Tests/BrowserTests.swift \
  -o build/browser-tests -framework AppKit -framework Carbon
build/browser-tests
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" \
  Sources/PiBrand.swift Sources/StatusAttentionDot.swift Sources/GlassPanel.swift Tests/AppearanceTests.swift \
  -o build/appearance-tests -framework AppKit -framework SwiftUI
build/appearance-tests
if [[ "${1:-}" == "--tui" ]]; then
  python3 Tests/terminal-cli-integration.py
fi
if [[ "${1:-}" == "--live" ]]; then
  xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" \
    Sources/SessionState.swift Sources/PiTransport.swift Tests/LiveProbe.swift -o build/live-probe
  build/live-probe
fi
if [[ "${1:-}" == "--render" ]]; then
  xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" \
    Sources/SessionState.swift Sources/ApprovalState.swift Sources/PiTransport.swift Sources/TerminalBridge.swift Sources/PiStore.swift \
    Sources/MenuView.swift Sources/TerminalQuestionnaireView.swift Sources/GlassPanel.swift Tests/RenderProbe.swift -o build/render-probe \
    -framework AppKit -framework SwiftUI -framework WebKit -framework UserNotifications
  build/render-probe
fi
