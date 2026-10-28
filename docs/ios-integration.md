# Glassboard iOS integration

Glassboard web and iOS clients share the same Supabase project, authentication users, PostgreSQL rows, Storage bucket, RLS policies, and Realtime channels.

## Supabase project

- Project URL: `https://atjaxxsvrqehjrtrqpzd.supabase.co`
- API key: use the project's **publishable** key in the iOS app. Never bundle a secret/service-role key.
- iOS callback URL: `glassboard://auth/callback`
- Email/password sign-up is enabled.
- Email confirmation is disabled, so a successful `signUp` immediately returns a usable session.

## Xcode configuration

1. Add the `supabase-swift` package: `https://github.com/supabase/supabase-swift`.
2. Copy `ios/Glassboard.xcconfig.example` to an untracked `Glassboard.xcconfig` and insert the publishable key.
3. Expose `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` through generated Info.plist values or a build configuration loader.
4. Register the `glassboard` URL scheme in the target's URL Types.
5. Initialize one `SupabaseClient` and keep its session persistent.

```swift
import Supabase

let client = SupabaseClient(
  supabaseURL: URL(string: GlassboardConfig.supabaseURL)!,
  supabaseKey: GlassboardConfig.publishableKey
)

let session = try await client.auth.signUp(
  email: email,
  password: password
).session

try await client.auth.signIn(email: email, password: password)
```

## Shared data contract

Use the tables created by `supabase/migrations/20261027000000_glassboard.sql`. Always use the signed-in user's client session; RLS decides access. The iOS app should subscribe to `cards`, `comments`, and `notifications` for live changes. Attachment object paths must be `<card UUID>/<generated filename>` in the private `attachments` bucket.

Dates are ISO-8601 timestamps in UTC. Card/list ordering uses decimal `position` values. Never use local-only state as the source of truth.

## Deep-link handling

Handle `glassboard://auth/callback` in SwiftUI with `.onOpenURL` and pass the URL to Supabase Auth when using OAuth or magic links. Email/password sign-up and login do not require a callback, but the URL is registered for future Apple sign-in and account recovery.
