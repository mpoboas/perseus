# OAuth sign-in setup

Perseus signs in to GitHub and GitLab with the OAuth **device flow**: it shows a short
code, you approve it on the provider's own page, and Perseus receives a token that goes
straight into your OS keychain. No client secret and no local web server are involved,
so the only thing Perseus needs is each provider's public **client ID**.

## GitHub

1. GitHub > Settings > Developer settings > OAuth Apps > New OAuth App.
2. Name it `Perseus`. The homepage and callback URL are required by the form but unused
   by the device flow (for example `http://127.0.0.1`).
3. Open the app and tick **Enable Device Flow**.
4. Copy the **Client ID**.

Scopes requested: `repo` (GitHub offers nothing narrower for private repositories; it also covers
creating and forking repositories), `workflow`, without which GitHub rejects any push that creates or changes a
file under `.github/workflows`, and `read:org`, which lets Perseus list your organizations when you create a
repository. Signing in again is needed for a token issued before one of these was added.
GitHub OAuth app tokens do not expire. For organisation repositories an owner may need
to approve the app.

## GitLab

1. GitLab > User Settings > Applications > Add new application (or a group/instance app).
2. Untick **Confidential**. Select the scopes `api`, `read_user`, `read_repository` and
   `write_repository`. The redirect URI is unused by the device flow (`http://127.0.0.1`).
   Perseus asks for `api`, which listing your projects, creating and forking them, and merge requests
   need (git itself only needs the other two). If the application was registered without `api`, GitLab
   refuses it and Perseus signs in for git access only; the account features then say so. Tick `api`
   on the application and sign in again to get them.
3. Tick **Device authorization grant** ("Enable to allow Device authorization grant flow").
   **This is easy to miss and is off by default.** Without it gitlab.com answers every
   sign-in request with a bare `access_denied`, whatever scopes are requested. It can be
   ticked later by editing the application.
4. Copy the **Application ID** (this is the client ID).

Tokens expire after two hours; the credential helper renews them automatically using the
refresh token. Self-hosted GitLab (17.9+, where the device grant is generally available)
needs an application registered on that instance: enter its host and client ID in the
sign-in form.

## Telling Perseus the client IDs

For the built-in hosts (`github.com`, `gitlab.com`) put the two IDs in a `.env` file at the
repository root (copy `.env.example`; `.env` itself is not committed):

```
PERSEUS_GITHUB_CLIENT_ID=<client id>
PERSEUS_GITLAB_CLIENT_ID=<application id>
```

`src-tauri/build.rs` reads that file at build time and compiles the values into the app, so a
built copy signs in without anything else being set, wherever it is launched from. An environment
variable of the same name takes priority over the file, both when building and when running, which
is handy for trying another OAuth app.

Client IDs are public identifiers, not secrets, so compiling them in is fine. For any
other host (GitHub Enterprise Server, self-hosted GitLab) paste the client ID into the
sign-in form instead.

## Bitbucket Cloud

Bitbucket's OAuth requires a client secret and has no device flow, so there is no
one-click sign-in. Create an API token in Bitbucket and paste it under **Or paste a
token** with the host `bitbucket.org`.
