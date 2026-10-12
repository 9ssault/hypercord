# Token login: what is known, and how the client signs in with a token

This file exists because token login was attempted twice from assumptions. Everything
below is either **measured** (a real observation, with where it came from) or marked
**inferred** / **unknown**. Nothing here is a claim about how Discord works from memory.

## Measured

| Fact | Evidence |
| --- | --- |
| The page's own world has no storage: `typeof localStorage` is `"undefined"` | The probe's own report, and the write script's error when it is tried there |
| A **same-origin frame** does have storage, and a raw write through `frame.contentWindow.localStorage` lands and reads back exactly | The write script reads the value back before reporting `ok:same-origin frame` |
| The client did **not** use a token written there | `signin.log` from the live client: `write=same-origin frame used=false landed= verdict=rejected` - the bytes are in storage and no request the client made carried them |
| The route decides a sign-in, and the route only | `decideSignIn` and its suite: a token still in storage does not make `/login` a sign-in (that was the original bug) |
| The client restores a session when the **app** boots, never on the login page | The sign-in boots `/app` and judges where it lands; a reload of the login page is never a session |
| A token is enough for Discord to accept an account - on the gateway, not in the browser | The sibling selfbot in this workspace: `await this.client.login(this.token)` in `hypersb-edit/src/bot.js:1606`, which signs a real account in with the raw token |

So: the write half works, the consumption half does not, and the reason is **not** known
yet - it is not `localStorage.token` on this build.

## What the shell does now, in order

1. **Probe the live page first** (`storageProbeScript` in `src/signin.js`): which storages
   exist in the page's world, in a same-origin frame and (the part that answers the open
   question) which of the client's **own modules** expose an auth-looking export. The
   report carries names, lengths and module ids - never a value. It is written to
   `signin.log` as `probe:` and `probe client:` lines, before anything is written to the
   page.
2. **Write the token to the placements, ordered by evidence** (`signInCandidates`): the
   frame write (measured to land), the page's own storage (kept for a build that still
   has one), and - only with a target the probe named - the IndexedDB store whose keys
   look like auth. A placement the probe ruled out is recorded as *not attempted* with
   its reason, never as a failure.
3. **Call the client's own sign-in**, when the probe found one
   (`pickClientAuth` / `clientSignInScript`): `handleTokenLogin`, then `login`, then
   `setToken`/`startSession`, then the first callable auth export. The module id comes
   from the probe; nothing is guessed. With no target it answers
   `err:not attempted: the probe found no callable auth export in the client's own
   modules`.
4. **Capture the session the client established** (`captureSessionScript`): the reliable
   half. If the page ends up signed in - by a token, by the password form, by a session
   that was already there - the client has stored it somewhere, and it is read from the
   places the probe named and put in the token store. This works whether or not any
   placement ever does.
5. **Judge the route**, and only the route, and report which half failed: the client
   never used the token, or it used it and Discord refused it.

## What to run, and what to read

One sign-in click writes everything needed to `signin.log` in the app's user data
directory (`%APPDATA%\Hypercord\signin.log` on Windows, `~/Library/Application
Support/Hypercord/signin.log` on macOS, `~/.config/Hypercord/signin.log` on Linux):

```
probe: page.local=[...] page.session=[...] frame.local=[...] cookies=[names] indexeddb=[db:store=key(len)* | ...]
probe client: registry=true require=true modules=NNNN candidates=[42226[getToken,login]->login ...]
client sign-in: ok:client 42226.login returned boolean used=true landed=/channels/@me verdict=accepted
```

The `probe client:` line is the measurement this file was waiting for: a module id and
the auth export names the client's own registry exposes. The `client sign-in:` line says
whether calling it worked. A `capture:` line says the client's session was found and
stored, and which place and key it came from - names only, never the value.

## Unknowns, stated as unknowns

* **Where this build reads a session from.** Not `localStorage.token`. The probe is what
  answers it; until the `probe client:` line is read on a live page, this is open.
* **Whether the client's `login`/`handleTokenLogin` accepts a raw user token** or expects
  a session object. If it refuses, the log will say so with the client's own error name.
* **Whether a token written *before* the app boots is read at all.** The two-pass attempt
  and the `/app` boot are the current best effort, and are labelled as such rather than
  called a fix.

## Rules that do not change

* A token is written only into the page, never into a log, and never into an error
  message: `signin.log` records places, key names, verdicts and reasons.
* The store keeps a token only through `src/tokens.js` (encrypted when a cipher exists,
  memory-only otherwise), and `capture` stores the client's own session under the same
  account id.
* "Stored" and "signed in" stay two different things, and the caller is told which one
  happened.
