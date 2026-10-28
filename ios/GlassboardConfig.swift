import Foundation

enum GlassboardConfig {
    static var supabaseURL: String {
        requiredInfoValue("SUPABASE_URL")
    }

    static var publishableKey: String {
        requiredInfoValue("SUPABASE_PUBLISHABLE_KEY")
    }

    static let authCallback = URL(string: "glassboard://auth/callback")!

    private static func requiredInfoValue(_ key: String) -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty else {
            preconditionFailure("Missing required Info.plist value: \(key)")
        }
        return value
    }
}
