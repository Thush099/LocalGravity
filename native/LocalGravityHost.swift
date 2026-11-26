import Cocoa
import Security
import ServiceManagement
import WebKit

final class GravityWebView: WKWebView {
    var onFilesDropped: (([String]) -> Void)?

    override init(frame frameRect: NSRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frameRect, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self]) as? [URL], !urls.isEmpty {
            return .copy
        }
        return super.draggingEntered(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self]) as? [URL], !urls.isEmpty {
            let paths = urls.map { $0.path }
            onFilesDropped?(paths)
            return true
        }
        return super.performDragOperation(sender)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var visualEffectView: NSVisualEffectView!
    private var webView: GravityWebView!
    private var serverProcess: Process?
    private var serverStdinPipe: Pipe?
    private var authToken: String = ""
    private var serverPort: Int = 0
    private var stdoutBuffer = ""
    private var stderrBuffer = ""
    private var isQuitting = false
    private var pendingDeepLinks: [URL] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()
        setupWindow()
        startBackendServer()
    }

    // A persistent agent should keep running when its window closes; macOS
    // gestures (Mission Control, Show Desktop, App Exposé) can close the window
    // and must not silently take the whole app down. The Dock icon reopens it.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows {
            window?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    // Deep links (localgravity://action/<name>, localgravity://open?path=<path>)
    // let external scripts / Shortcuts drive the app. They are queued until the
    // webview has loaded so a launch-via-URL still lands on the target action.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme?.lowercased() == "localgravity" {
            pendingDeepLinks.append(url)
        }
        flushPendingDeepLinks()
    }

    private func flushPendingDeepLinks() {
        guard let webView, !webView.isLoading, webView.url != nil, !pendingDeepLinks.isEmpty else { return }
        let queued = pendingDeepLinks
        pendingDeepLinks.removeAll()
        for url in queued {
            handleDeepLink(url)
        }
    }

    private func handleDeepLink(_ url: URL) {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let host = (url.host ?? "").lowercased()
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if host == "action", !path.isEmpty {
            sendMenuAction(path)
        } else if host == "open" {
            let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "path" })?.value
            if let target {
                let expanded = (target as NSString).expandingTildeInPath
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: expanded)])
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        isQuitting = true
        stopBackendServer()
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // App Menu
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About LocalGravity", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Settings…", action: #selector(triggerSettings), keyEquivalent: ",")
        let loginItem = NSMenuItem(title: "Start at Login", action: #selector(toggleLaunchAtLogin(_:)), keyEquivalent: "")
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        appMenu.addItem(loginItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide LocalGravity", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthersItem = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthersItem.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthersItem)
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit LocalGravity", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        // File Menu
        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "New Task", action: #selector(triggerNewTask), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "Open Project Folder…", action: #selector(triggerOpenFolder), keyEquivalent: "o")
        fileMenu.addItem(NSMenuItem.separator())
        let exportItem = NSMenuItem(title: "Export Conversation…", action: #selector(triggerExport), keyEquivalent: "e")
        exportItem.keyEquivalentModifierMask = [.command, .shift]
        fileMenu.addItem(exportItem)
        fileMenuItem.submenu = fileMenu

        // Edit Menu
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        // View Menu
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Command Palette…", action: #selector(triggerPalette), keyEquivalent: "k")
        viewMenu.addItem(withTitle: "Toggle Sidebar", action: #selector(triggerToggleSidebar), keyEquivalent: "\\")
        viewMenu.addItem(NSMenuItem.separator())

        let viewSpecs: [(String, String, String)] = [
            ("Dashboard", "dashboard", "1"),
            ("Agent", "agent", "2"),
            ("System Monitor", "monitor", "3"),
            ("Timetable", "schedule", "4"),
            ("Skills & Knowledge", "skills", "5"),
            ("Automations", "automations", "6")
        ]
        for (title, viewId, key) in viewSpecs {
            let item = NSMenuItem(title: title, action: #selector(triggerViewSwitch(_:)), keyEquivalent: key)
            item.representedObject = viewId
            viewMenu.addItem(item)
        }

        viewMenu.addItem(NSMenuItem.separator())
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadWebView), keyEquivalent: "r")
        let fullScreenItem = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreenItem.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullScreenItem)
        viewMenuItem.submenu = viewMenu

        // Window Menu
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    private func sendMenuAction(_ action: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: action),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__lgMenuAction && window.__lgMenuAction(\(json));")
    }

    @objc private func toggleLaunchAtLogin(_ sender: NSMenuItem) {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            // Registration can be denied by the user or the system; keep the menu truthful.
            NSLog("Launch at Login change failed: \(error.localizedDescription)")
        }
        sender.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    @objc private func triggerSettings() {
        sendMenuAction("settings")
    }

    @objc private func triggerNewTask() {
        sendMenuAction("newTask")
    }

    @objc private func triggerOpenFolder() {
        sendMenuAction("pickFolder")
    }

    @objc private func triggerExport() {
        sendMenuAction("export")
    }

    @objc private func triggerPalette() {
        sendMenuAction("palette")
    }

    @objc private func triggerToggleSidebar() {
        sendMenuAction("toggleSidebar")
    }

    @objc private func triggerViewSwitch(_ sender: NSMenuItem) {
        if let viewId = sender.representedObject as? String {
            sendMenuAction("view:\(viewId)")
        }
    }

    @objc private func reloadWebView() {
        webView?.reload()
    }

    private func setupWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "localgravity")
        let nativeScript = WKUserScript(
            source: "document.documentElement.classList.add('is-macos-native');",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(nativeScript)

        let rect = NSRect(x: 0, y: 0, width: 1280, height: 840)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        if !window.setFrameUsingName("LocalGravityMainWindow") {
            window.center()
        }
        window.setFrameAutosaveName("LocalGravityMainWindow")
        window.title = "LocalGravity"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        window.collectionBehavior = [.fullScreenPrimary]
        window.minSize = NSSize(width: 920, height: 600)
        window.backgroundColor = NSColor(srgbRed: 0.043, green: 0.047, blue: 0.059, alpha: 1.0)
        window.isReleasedWhenClosed = false

        visualEffectView = NSVisualEffectView(frame: rect)
        visualEffectView.material = .underWindowBackground
        visualEffectView.blendingMode = .behindWindow
        visualEffectView.state = .followsWindowActiveState
        visualEffectView.autoresizingMask = [.width, .height]

        webView = GravityWebView(frame: visualEffectView.bounds, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.onFilesDropped = { [weak self] paths in
            self?.sendFilesToJS(paths)
        }

        visualEffectView.addSubview(webView)
        window.contentView = visualEffectView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func generateAuthToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func findNodeExecutable() -> String? {
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        return nil
    }

    private func startBackendServer() {
        guard let resourcesDir = Bundle.main.resourcePath else {
            showStartupError("Missing app Resources directory.")
            return
        }
        let serverPath = (resourcesDir as NSString).appendingPathComponent("backend/server.mjs")
        guard FileManager.default.fileExists(atPath: serverPath) else {
            showStartupError("Missing bundled backend at \(serverPath)")
            return
        }
        guard let nodePath = findNodeExecutable() else {
            showStartupError("Node.js not found at /opt/homebrew/bin/node or /usr/local/bin/node.")
            return
        }

        authToken = generateAuthToken()

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [serverPath]

        var env = ProcessInfo.processInfo.environment
        env["AUTH_TOKEN"] = authToken
        env["PORT"] = "0"
        env["LOCALGRAVITY_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        let basePath = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:\(basePath)"
        proc.environment = env

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardInput = stdinPipe
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe
        serverStdinPipe = stdinPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in
                self?.handleBackendStdout(chunk)
            }
        }

        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.stderrBuffer += chunk
                if self.stderrBuffer.count > 8192 {
                    self.stderrBuffer = String(self.stderrBuffer.suffix(8192))
                }
            }
        }

        proc.terminationHandler = { [weak self] process in
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.isQuitting { return }
                let msg = self.stderrBuffer.isEmpty ? "Unknown backend error" : self.stderrBuffer
                if self.serverPort == 0 {
                    self.showStartupError("Agent backend failed to start:\n\(msg)")
                } else {
                    self.showStartupError(
                        "The agent backend stopped unexpectedly (exit code \(process.terminationStatus)).\n\n\(msg)\n\nQuit and reopen LocalGravity to restart it.",
                        title: "LocalGravity backend stopped"
                    )
                }
            }
        }

        do {
            try proc.run()
            serverProcess = proc
        } catch {
            showStartupError("Failed to launch Node backend: \(error.localizedDescription)")
        }
    }

    private func handleBackendStdout(_ chunk: String) {
        stdoutBuffer += chunk
        while let range = stdoutBuffer.range(of: "\n") {
            let line = String(stdoutBuffer[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            stdoutBuffer = String(stdoutBuffer[range.upperBound...])
            if line.hasPrefix("READY:"), let port = Int(line.dropFirst(6)), serverPort == 0 {
                serverPort = port
                if let url = URL(string: "http://127.0.0.1:\(port)/?token=\(authToken)") {
                    webView?.load(URLRequest(url: url))
                }
            }
        }
    }

    private func stopBackendServer() {
        serverStdinPipe?.fileHandleForWriting.closeFile()
        serverStdinPipe = nil
        guard let proc = serverProcess, proc.isRunning else { return }
        proc.terminate()
        let deadline = Date().addingTimeInterval(1.5)
        while proc.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if proc.isRunning {
            kill(proc.processIdentifier, SIGKILL)
        }
    }

    private func showStartupError(_ message: String, title: String = "LocalGravity could not start") {
        let html = """
        <!doctype html><html><body style="font-family:-apple-system,sans-serif;background:#0b0c0f;color:#f5f5f7;padding:48px;">
        <h2>\(title)</h2>
        <pre style="white-space:pre-wrap;background:#15181f;padding:16px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);">\(message)</pre>
        </body></html>
        """
        webView?.loadHTMLString(html, baseURL: nil)
    }

    private func sendFilesToJS(_ paths: [String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: paths),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__lgReceiveFiles && window.__lgReceiveFiles(\(json));")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        // Defensive: every window/webView access below must never crash the host.
        guard let window = window else { return }
        if type == "pickFiles" {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = true
            panel.beginSheetModal(for: window) { [weak self] response in
                if response == .OK {
                    self?.sendFilesToJS(panel.urls.map { $0.path })
                }
            }
        } else if type == "pickFolder" {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "Select Project Folder"
            panel.beginSheetModal(for: window) { [weak self] response in
                if response == .OK, let folderUrl = panel.url,
                   let data = try? JSONSerialization.data(withJSONObject: folderUrl.path),
                   let json = String(data: data, encoding: .utf8) {
                    self?.webView?.evaluateJavaScript("window.__lgFolderPicked && window.__lgFolderPicked(\(json));")
                }
            }
        } else if type == "revealInFinder", let rawPath = body["path"] as? String, !rawPath.isEmpty {
            let expanded = (rawPath as NSString).expandingTildeInPath
            if FileManager.default.fileExists(atPath: expanded) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: expanded)])
            }
        } else if type == "setTheme", let theme = body["theme"] as? String {
            switch theme {
            case "light":
                window.appearance = NSAppearance(named: .aqua)
                window.backgroundColor = NSColor(srgbRed: 0.957, green: 0.961, blue: 0.973, alpha: 1.0)
            case "nord":
                window.appearance = NSAppearance(named: .darkAqua)
                window.backgroundColor = NSColor(srgbRed: 0.180, green: 0.204, blue: 0.251, alpha: 1.0)
            case "solarized":
                window.appearance = NSAppearance(named: .darkAqua)
                window.backgroundColor = NSColor(srgbRed: 0.000, green: 0.169, blue: 0.212, alpha: 1.0)
            case "cyberpunk":
                window.appearance = NSAppearance(named: .darkAqua)
                window.backgroundColor = NSColor(srgbRed: 0.043, green: 0.027, blue: 0.086, alpha: 1.0)
            case "dark":
                window.appearance = NSAppearance(named: .darkAqua)
                window.backgroundColor = NSColor(srgbRed: 0.043, green: 0.047, blue: 0.059, alpha: 1.0)
            default:
                window.appearance = nil
                window.backgroundColor = NSColor.windowBackgroundColor
            }
        } else if type == "openExternal", let urlStr = body["url"] as? String, let url = URL(string: urlStr) {
            NSWorkspace.shared.open(url)
        } else if type == "saveFile", let content = body["content"] as? String {
            let suggestedName = (body["filename"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let panel = NSSavePanel()
            panel.nameFieldStringValue = (suggestedName?.isEmpty == false) ? (suggestedName ?? "conversation.md") : "conversation.md"
            panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { [weak self] response in
                if response == .OK, let destUrl = panel.url {
                    do {
                        try content.write(to: destUrl, atomically: true, encoding: .utf8)
                        if let data = try? JSONSerialization.data(withJSONObject: destUrl.path),
                           let json = String(data: data, encoding: .utf8) {
                            self?.webView?.evaluateJavaScript("window.__lgFileSaved && window.__lgFileSaved(\(json));")
                        }
                    } catch {
                        // Best-effort save error handling
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        flushPendingDeepLinks()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let host = url.host,
           host != "127.0.0.1" && host != "localhost" && (url.scheme == "http" || url.scheme == "https") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
