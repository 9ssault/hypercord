  // Applied inside the pinned Revenge closure; uses its React, Emitter and symbols.
  function useProxy(storage) {
    var emitter = storage?.[emitterSymbol];
    if (!emitter || typeof emitter.on !== "function" || typeof emitter.off !== "function")
      throw new TypeError("useProxy requires storage created by createStorage, wrapSync or createProxy");
    var [, forceUpdate] = React.useReducer((n) => ~n, 0);
    React.useEffect(() => {
      var listener = () => forceUpdate();
      emitter.on("SET", listener);
      emitter.on("DEL", listener);
      // Cover hydration or a mutation between render and effect subscription.
      forceUpdate();
      return () => {
        emitter.off("SET", listener);
        emitter.off("DEL", listener);
      };
    }, [storage, emitter]);
    return storage;
  }
  function createStorage(backend) {
    return _async_to_generator(function* () {
      var data = yield backend.get();
      if (data === null || typeof data !== "object")
        throw new TypeError("Storage must contain a JSON object or array");
      var { proxy, emitter } = createProxy(data);
      var handler = () => backend.set(proxy);
      emitter.on("SET", handler);
      emitter.on("DEL", handler);
      return proxy;
    })();
  }
  function getStorageState(storage) {
    if (!storage?.[emitterSymbol])
      throw new TypeError("getStorageState requires a proxied store");
    return storage[Symbol.for("assault.storage.state")] ?? { status: "ready", error: null };
  }
  function useStorageState(storage) {
    return getStorageState(useProxy(storage));
  }
  function wrapSync(store) {
    // A real proxy exists from the first render. Never persist placeholder data.
    var pending = createProxy();
    var awaited;
    var state = { status: "loading", error: null };
    var promise = Promise.resolve(store).then((value) => {
      if (!value?.[emitterSymbol])
        throw new TypeError("wrapSync requires a promise of proxied storage");
      awaited = value;
      state = { status: "ready", error: null };
      pending.emitter.emit("SET", { path: [], value });
    });
    // Handle failures even when no caller awaits the store. Awaiters still reject.
    promise.catch((error) => {
      state = { status: "error", error };
      pending.emitter.emit("SET", { path: [], value: void 0 });
    });
    var requireReady = () => {
      if (state.status !== "ready")
        throw state.error ?? new Error("Await storage before changing settings");
      return awaited;
    };
    return new Proxy({}, {
      get(target, prop, recv) {
        if (prop === syncAwaitSymbol)
          return (resolve, reject) => promise.then(resolve, reject);
        if (prop === Symbol.for("assault.storage.state"))
          return state;
        return Reflect.get(awaited ?? pending.proxy, prop, recv);
      },
      set(target, prop, value) { return Reflect.set(requireReady(), prop, value); },
      deleteProperty(target, prop) { return Reflect.deleteProperty(requireReady(), prop); },
      defineProperty(target, prop, descriptor) { return Reflect.defineProperty(requireReady(), prop, descriptor); },
      has(target, prop) { return Reflect.has(awaited ?? pending.proxy, prop); },
      ownKeys() { return Reflect.ownKeys(awaited ?? pending.proxy); },
      getOwnPropertyDescriptor(target, prop) {
        var descriptor = Reflect.getOwnPropertyDescriptor(awaited ?? pending.proxy, prop);
        // The facade's empty target must not report non-configurable properties.
        return descriptor && { ...descriptor, configurable: true };
      }
    });
  }
  function awaitStorage(...stores) {
    return Promise.all(stores.map((store) => new Promise((resolve, reject) => {
      var wait = store?.[syncAwaitSymbol];
      if (wait) wait(resolve, reject);
      else if (store?.[emitterSymbol]) resolve();
      else reject(new TypeError("awaitStorage requires a proxied store"));
    })));
  }
