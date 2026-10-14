// a fixture plugin that leaves work running on purpose.
//
// Everything it starts it asks the *host* for - `ctx.interval`, `ctx.onCleanup` - so the
// test can prove that stopping the host takes both of them down. A plugin that reached
// for a global `setInterval` could not be stopped from outside, which is why the context
// offers one, and why this fixture uses nothing else. What it did is recorded in a global
// the test reads, the way the other fixtures here record their start and stop.
const seen = () => globalThis.__probeSeen || (globalThis.__probeSeen = { ticks: 0, stopped: 0, cleaned: 0, order: [], id: "", via: "", stopCtx: "" });

export default {
  name: "probe",
  description: "a fixture plugin that leaves a timer and two cleanups behind",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: true,

  start(ctx) {
    const state = seen();
    state.id = ctx.id;
    // what the host offered, so the test can see the helpers are really there rather
    // than being tolerated as undefined
    state.via = [typeof ctx.interval, typeof ctx.timeout, typeof ctx.onCleanup, typeof ctx.local].join(",");
    ctx.interval(() => {
      state.ticks += 1;
    }, 20);
    // two cleanups, to pin the order they run in: newest first
    ctx.onCleanup(() => {
      state.cleaned += 1;
      state.order.push("first");
    });
    ctx.onCleanup(() => {
      state.cleaned += 1;
      state.order.push("second");
    });
    return { id: ctx.id };
  },

  stop(ctx) {
    seen().stopped += 1;
    seen().stopCtx = ctx.id;
  },
};
