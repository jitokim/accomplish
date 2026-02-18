# Browser Auth GUI Flow

## Goal

Make OpenCode CLI browser authentication reliable in the Electron GUI when PTY output is fragmented or ANSI-colored.

## Supported Modes

- API key login remains unchanged.
- Browser auth is an alternative path for OpenAI (ChatGPT) and Google.

## State Machine

Renderer follows this state flow:

`idle -> waiting_browser_auth -> polling -> success | failed | timeout`

State meanings:

- `idle`: request initialized.
- `waiting_browser_auth`: waiting for URL from CLI output, or URL detected and waiting for browser action.
- `polling`: CLI started polling auth completion.
- `success`: auth flow completed with exit code 0.
- `failed`: non-zero exit, cancellation, or validation mismatch.
- `timeout`: max wait exceeded.

## PTY Parsing Strategy

Main process (`apps/desktop/src/main/opencode/auth-browser.ts`) parses node-pty output with these rules:

1. Strip ANSI escape sequences.
2. Normalize carriage returns/newlines.
3. Keep rolling output buffer (20k chars) to handle fragmented chunks.
4. Extract URLs using HTTP(S) regex from the full rolling buffer, not single lines.
5. Detect prompts/status messages from normalized lowercase text:
   - provider selection
   - login method
   - polling/waiting status
   - success hints

## GUI Interaction

- Clicking "Login with ..." triggers `opencode:auth:browser:login`.
- Main process emits progress via `opencode:auth:browser:progress`.
- Renderer subscribes and updates local state/message/URL.
- When URL is detected:
  - app tries `shell.openExternal()` automatically.
  - GUI also shows a manual clickable URL action as fallback.

## Failure Handling and Next Steps

On `failed` or thrown errors, UI shows clear next-step guidance:

- Retry browser login.
- Open detected URL manually.
- Copy/export logs from Debug settings for support.

On `timeout`, state is explicit and user sees retry/manual-open guidance.

## Known Constraints

- OpenAI browser login can be verified with stored OAuth status.
- Google browser login currently relies on successful CLI completion (exit code) as primary success signal.
- CLI output wording may change in future OpenCode versions; parser uses multiple hints and full-buffer matching to reduce brittleness.
