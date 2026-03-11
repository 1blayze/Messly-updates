(function installMesslyConsoleNoiseFilter() {
  if (typeof window === "undefined" || typeof console === "undefined") {
    return;
  }

  if (window.__MESSLY_CONSOLE_NOISE_FILTER_INSTALLED__) {
    return;
  }
  window.__MESSLY_CONSOLE_NOISE_FILTER_INSTALLED__ = true;

  var NOISE_PATTERNS = [
    /download the react devtools for a better development experience/i,
    /request for the private access token challenge/i,
    /the next request for the private access token challenge may return a 401/i,
    /was preloaded using link preload but not used within a few seconds/i,
    /note that 'script-src' was not explicitly set/i,
    /font-size:0;color:transparent\s+nan/i,
    /^nan$/i,
  ];

  function normalizeLogPart(value) {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof Error) {
      return value.name + ": " + value.message;
    }
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value == null ? "" : value);
    }
  }

  function shouldSuppress(args) {
    var message = Array.prototype.map.call(args, normalizeLogPart).join(" ").trim();
    if (!message) {
      return false;
    }
    for (var index = 0; index < NOISE_PATTERNS.length; index += 1) {
      if (NOISE_PATTERNS[index].test(message)) {
        return true;
      }
    }
    return false;
  }

  function patch(methodName) {
    var original = console[methodName];
    if (typeof original !== "function") {
      return;
    }
    console[methodName] = function patchedConsoleMethod() {
      if (shouldSuppress(arguments)) {
        return;
      }
      return original.apply(console, arguments);
    };
  }

  patch("log");
  patch("info");
  patch("warn");
  patch("error");
})();
