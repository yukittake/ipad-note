import ExpoModulesCore
import UniformTypeIdentifiers
import UIKit

private class DirectoryPickerDelegate: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  weak var module: PersistentDirectoryModule?

  init(module: PersistentDirectoryModule) {
    self.module = module
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    module?.handlePickedDirectory(urls.first)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    module?.handlePickerCancellation()
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    module?.handlePickerCancellation()
  }
}

public class PersistentDirectoryModule: Module {
  private let bookmarksKey = "ipadNote.directoryBookmarks"
  private var pickerPromise: Promise?
  private var picker: UIDocumentPickerViewController?
  private var pickerDelegate: DirectoryPickerDelegate?
  private var accessedDirectories: [String: URL] = [:]

  public func definition() -> ModuleDefinition {
    Name("PersistentDirectory")

    AsyncFunction("pickDirectory") { (promise: Promise) in
      guard self.pickerPromise == nil else {
        promise.reject("PICKER_BUSY", "A directory picker is already open")
        return
      }
      guard let viewController = self.appContext?.utilities?.currentViewController() else {
        promise.reject("NO_VIEW_CONTROLLER", "Cannot present the directory picker")
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
      let delegate = DirectoryPickerDelegate(module: self)
      picker.delegate = delegate
      picker.presentationController?.delegate = delegate
      if UIDevice.current.userInterfaceIdiom == .pad {
        picker.modalPresentationStyle = .pageSheet
        picker.popoverPresentationController?.sourceView = viewController.view
        picker.popoverPresentationController?.sourceRect = CGRect(x: viewController.view.bounds.midX, y: viewController.view.bounds.midY, width: 0, height: 0)
      }
      self.pickerPromise = promise
      self.picker = picker
      self.pickerDelegate = delegate
      viewController.present(picker, animated: true)
    }.runOnQueue(.main)

    AsyncFunction("restoreDirectories") { () -> [[String: String]] in
      var result: [[String: String]] = []
      let bookmarks = self.loadBookmarks()
      var updatedBookmarks = bookmarks
      for (savedUri, encoded) in bookmarks {
        guard let data = Data(base64Encoded: encoded) else { continue }
        var stale = false
        do {
          let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
          guard self.access(url) else { continue }
          if stale {
            updatedBookmarks.removeValue(forKey: savedUri)
            updatedBookmarks[url.absoluteString] = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil).base64EncodedString()
          }
          result.append(["savedUri": savedUri, "uri": url.absoluteString])
        } catch {
          continue
        }
      }
      self.saveBookmarks(updatedBookmarks)
      return result
    }.runOnQueue(.main)

    AsyncFunction("forgetDirectory") { (uri: String) in
      var bookmarks = self.loadBookmarks()
      bookmarks.removeValue(forKey: uri)
      self.saveBookmarks(bookmarks)
      if let url = self.accessedDirectories.removeValue(forKey: uri) {
        url.stopAccessingSecurityScopedResource()
      }
    }.runOnQueue(.main)
  }

  fileprivate func handlePickedDirectory(_ pickedUrl: URL?) {
    defer { pickerPromise = nil; picker = nil; pickerDelegate = nil }
    guard let url = pickedUrl else {
      pickerPromise?.resolve(nil)
      return
    }
    guard access(url) else {
      pickerPromise?.reject("DIRECTORY_ACCESS_DENIED", "The selected directory is not accessible")
      return
    }
    do {
      let bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
      var bookmarks = loadBookmarks()
      bookmarks[url.absoluteString] = bookmark.base64EncodedString()
      saveBookmarks(bookmarks)
      pickerPromise?.resolve(url.absoluteString)
    } catch {
      pickerPromise?.reject("BOOKMARK_FAILED", "Could not remember the selected directory: \(error)")
    }
  }

  fileprivate func handlePickerCancellation() {
    pickerPromise?.resolve(nil)
    pickerPromise = nil
    picker = nil
    pickerDelegate = nil
  }

  private func access(_ url: URL) -> Bool {
    if accessedDirectories[url.absoluteString] != nil { return true }
    guard url.startAccessingSecurityScopedResource() else { return false }
    accessedDirectories[url.absoluteString] = url
    return true
  }

  private func loadBookmarks() -> [String: String] {
    UserDefaults.standard.dictionary(forKey: bookmarksKey) as? [String: String] ?? [:]
  }

  private func saveBookmarks(_ bookmarks: [String: String]) {
    UserDefaults.standard.set(bookmarks, forKey: bookmarksKey)
  }

  deinit {
    for url in accessedDirectories.values {
      url.stopAccessingSecurityScopedResource()
    }
  }
}
