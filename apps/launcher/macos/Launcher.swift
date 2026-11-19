import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var opened = false
    private var tasks: [Process] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { if !self.opened { self.launch(nil) } }
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        opened = true
        for file in filenames { launch(file) }
        sender.reply(toOpenOrPrint: .success)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { launch(nil); return true }
    private func launch(_ file: String?) {
        let resources = Bundle.main.resourceURL!
        let task = Process()
        task.executableURL = resources.appendingPathComponent("node")
        task.arguments = [resources.appendingPathComponent("cli.cjs").path, "open"] + (file.map { [$0] } ?? [])
        task.currentDirectoryURL = resources
        let log = FileManager.default.temporaryDirectory.appendingPathComponent("aib-launch-\(UUID().uuidString).log")
        do {
            FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
            let errorLog = try FileHandle(forWritingTo: log)
            task.standardError = errorLog
            task.standardOutput = FileHandle.nullDevice
            task.terminationHandler = { [weak self] p in
                try? errorLog.close()
                let reader = try? FileHandle(forReadingFrom: log)
                let data = (try? reader?.read(upToCount: 65536)) ?? Data()
                try? reader?.close()
                try? FileManager.default.removeItem(at: log)
                DispatchQueue.main.async {
                    self?.tasks.removeAll { $0 === p }
                    if p.terminationStatus != 0 {
                        let alert = NSAlert(); alert.messageText = "AIB 无法打开文件"
                        alert.informativeText = String(data: data, encoding: .utf8) ?? "Unknown error"
                        alert.runModal()
                    }
                }
            }
            do { try task.run(); tasks.append(task) }
            catch { try? errorLog.close(); throw error }
        } catch { try? FileManager.default.removeItem(at: log); let alert = NSAlert(error: error); alert.runModal() }
    }
}
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
