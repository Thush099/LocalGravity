import Cocoa
import Security
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
    private var webView: GravityWebView!
    private var serverProcess: Process?
    private var serverStdinPipe: Pipe?
    private var authToken: String = ""
    private var serverPort: Int = 0
    private var stdoutBuffer = ""
    private var stderrBuffer = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()
        setupWindow()
        startBackendServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopBackendServer()
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About LocalGravity", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit LocalGravity", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

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

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadWebView), keyEquivalent: "r")
        viewMenuItem.submenu = viewMenu

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func reloadWebView() {
        webView?.reload()
    }

    private func setupWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "localgravity")

        let rect = NSRect(x: 0, y: 0, width: 1260, height: 820)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = "LocalGravity"
        window.minSize = NSSize(width: 920, height: 600)
        window.backgroundColor = NSColor(srgbRed: 0.071, green: 0.082, blue: 0.106, alpha: 1.0)
        window.isReleasedWhenClosed = false

        webView = GravityWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.onFilesDropped = { [weak self] paths in
            self?.sendFilesToJS(paths)
        }

        window.contentView = webView
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
            DispatchQueue.main.async {
                self?.handleBackendStdout(chunk)
            }
        }

        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
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
            DispatchQueue.main.async {
                guard let self else { return }
                if process.terminationStatus != 0 && self.serverPort == 0 {
                    let msg = self.stderrBuffer.isEmpty ? "Unknown backend error" : self.stderrBuffer
                    self.showStartupError("Agent backend failed to start:\n\(msg)")
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
                    webView.load(URLRequest(url: url))
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

    private func showStartupError(_ message: String) {
        let html = """
        <!doctype html><html><body style="font-family:-apple-system,sans-serif;background:#12151b;color:#edf2f7;padding:40px;">
        <h2>LocalGravity could not start</h2>
        <pre style="white-space:pre-wrap;background:#181c24;padding:16px;border-radius:8px;">\(message)</pre>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func sendFilesToJS(_ paths: [String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: paths),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__lgReceiveFiles && window.__lgReceiveFiles(\(json));")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
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
        } else if type == "openExternal", let urlStr = body["url"] as? String, let url = URL(string: urlStr) {
            NSWorkspace.shared.open(url)
        } else if type == "saveFile", let content = body["content"] as? String {
            let suggestedName = (body["filename"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let panel = NSSavePanel()
            panel.nameFieldStringValue = (suggestedName?.isEmpty == false ? suggestedName! : "conversation.md")
            panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { [weak self] response in
                if response == .OK, let destUrl = panel.url {
                    do {
                        try content.write(to: destUrl, atomically: true, encoding: .utf8)
                        if let data = try? JSONSerialization.data(withJSONObject: destUrl.path),
                           let json = String(data: data, encoding: .utf8) {
                            self?.webView.evaluateJavaScript("window.__lgFileSaved && window.__lgFileSaved(\(json));")
                        }
                    } catch {
                        // Best-effort save error handling
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
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
