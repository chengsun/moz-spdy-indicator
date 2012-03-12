let Ci = Components.interfaces;
let Cc = Components.classes;

var SPDYObserver = {
  indicatorTooltips: {
    "inactive":  "SPDY is inactive",
    "subactive": "SPDY is active for sub-documents included in the top-level document",
    "active":    "SPDY is active for the top-level document"
  },

  start: function () {
    var observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
    observerService.addObserver(SPDYObserver, "http-on-examine-response", false);
    observerService.addObserver(SPDYObserver, "http-on-examine-merged-response", false);
    observerService.addObserver(SPDYObserver, "http-on-examine-cached-response", false);

    window.addEventListener("load", function () {
      gBrowser.addEventListener("load", SPDYObserver.update, true);
      gBrowser.addEventListener("select", SPDYObserver.update, false);
    }, false);
  },

  update: function () {
    var spdyRequests = gBrowser.selectedBrowser.getUserData("__spdyindicator_spdyrequests");
    var state;
    if (!spdyRequests)                                    state = "inactive";
    else if (!(gBrowser.currentURI.spec in spdyRequests)) state = "subactive";
    else                                                  state = "active";

    var indicator = document.getElementById("spdyindicator-icon");
    indicator.setAttribute("hidden", state === "inactive");
    indicator.setAttribute("state", state);
    indicator.setAttribute("tooltiptext", SPDYObserver.indicatorTooltips[state]);
  },

  observe: function (subject, topic, data)  {
    switch (topic) {
      case "http-on-examine-response":
      case "http-on-examine-cached-response":
      case "http-on-examine-merged-response":
        subject.QueryInterface(Ci.nsIHttpChannel);
        var requestURI = subject.URI.spec;

        // make sure we are requested via SPDY
        var spdyHeader = null;
        try {
          spdyHeader = subject.getResponseHeader("X-Firefox-Spdy");
        } catch (e) {}
        if (!spdyHeader || !spdyHeader.length) return;

        // find the browser which this request originated from
        var win = SPDYObserver.getLoadContext(subject);
        if (!win) return;
        var browser = gBrowser.getBrowserForDocument(win.top.document);
        if (!browser) return;

        var spdyRequests = browser.getUserData("__spdyindicator_spdyrequests") || {};
        spdyRequests[requestURI] = true;
        browser.setUserData("__spdyindicator_spdyrequests", spdyRequests, null);
        SPDYObserver.update();
        break;
    }
  },

  getLoadContext: function (request) {
    var loadContext = null;
    try {
      loadContext = request.QueryInterface(Ci.nsIChannel)
                           .notificationCallbacks
                           .getInterface(Ci.nsILoadContext);
    } catch (e) {
      try {
        loadContext = request.loadGroup
                             .notificationCallbacks
                             .getInterface(Ci.nsILoadContext);
      } catch (e) {}
    }

    if (!loadContext) return null;
    return loadContext.associatedWindow;
  },
};

SPDYObserver.start();
