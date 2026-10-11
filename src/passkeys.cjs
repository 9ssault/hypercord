// language: JavaScript, file: src/passkeys.cjs
//
// The passkey policy, in one place.
//
// Why this exists. Discord's login page asks for a discoverable credential
// ("passkey autofill", `mediation: "conditional"`) as soon as the form is on
// screen. Chromium answers that on Windows by opening the operating system's
// "choose a passkey" dialog - Security / Sécurité Windows - even though nobody
// clicked anything. It is Windows', not ours, and it is not wanted here: this
// client signs in with the email and password form, or with a user token.
//
// What it does. The dialog is raised in the browser process, so the only place
// to stop it is before the request leaves the page: the policy is injected into
// the page's own world before any of Discord's scripts run, and it refuses the
// requests a page makes *by itself* while leaving the ones a person actually
// asks for alone.
//
//   * a conditional request (the uninvited one) is always refused;
//   * a WebAuthn request with no user activation behind it is refused - a click
//     is what makes a passkey request legitimate;
//   * everything else passes through untouched, so signing in with a passkey, if
//     somebody deliberately chooses it, still works, and so does every non
//     WebAuthn use of navigator.credentials (passwords, federated, and so on);
//   * the platform is told there is no conditional mediation to offer, which is
//     the documented way to say "do not offer a passkey here at all".
//
// The injected script is a string because it has to run in another world; it
// leaves `window.__hypercordPasskeys` behind ("on-demand", or "unpatched: ...")
// and a short, bounded record of what it refused in
// `window.__hypercordPasskeyCalls` - the challenge and the credential options are
// deliberately not kept, only what kind of request it was and what was decided,
// so "the dialog popped up again" can be answered from the page instead of by
// guessing. Both are what the preload test asserts against.
const POLICY = `(() => {
  try {
    const creds = navigator.credentials;
    const record = [];
    window.__hypercordPasskeyCalls = record;
    const note = (kind, why) => {
      record.push(kind + ": " + why);
      if (record.length > 10) record.shift();
    };
    const refusal = (kind, why) => {
      note(kind, why);
      return Promise.reject(new DOMException("Hypercord does not raise the system passkey prompt on its own - click to use a passkey, or sign in with a token", "NotAllowedError"));
    };
    const invited = () => {
      const activation = navigator.userActivation;
      return !activation || activation.isActive === true;
    };
    const isWebAuthn = (options) => Boolean(options && options.publicKey);
    if (creds && typeof creds.get === "function") {
      const realGet = creds.get.bind(creds);
      const get = function (options) {
        if (!isWebAuthn(options)) return realGet(options);
        if (String((options && options.mediation) || "") === "conditional") return refusal("get", "conditional, so it was asked for by the page alone");
        return invited() ? realGet(options) : refusal("get", "no click behind it");
      };
      get.__hypercord = true;
      Object.defineProperty(creds, "get", { value: get, writable: true, configurable: true });
      if (typeof creds.create === "function") {
        const realCreate = creds.create.bind(creds);
        const create = function (options) {
          if (!isWebAuthn(options)) return realCreate(options);
          return invited() ? realCreate(options) : refusal("create", "no click behind it");
        };
        create.__hypercord = true;
        Object.defineProperty(creds, "create", { value: create, writable: true, configurable: true });
      }
    }
    if (window.PublicKeyCredential && typeof PublicKeyCredential.isConditionalMediationAvailable === "function") {
      Object.defineProperty(PublicKeyCredential, "isConditionalMediationAvailable", {
        value: () => Promise.resolve(false),
        writable: true,
        configurable: true,
      });
    }
    window.__hypercordPasskeys = "on-demand";
  } catch (err) {
    window.__hypercordPasskeys = "unpatched:" + String((err && err.message) || err);
  }
})();`;

module.exports = { POLICY };
