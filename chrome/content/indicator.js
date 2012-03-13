let Ci = Components.interfaces;
let Cc = Components.classes;

var SPDYObserver = {
  indicatorStates: [
    {
      name: "unknown",
      tooltip: "SPDY state unknown",
    }, {
      name: "inactive",
      tooltip: "SPDY is inactive",
    }, {
      name: "subactive",
      tooltip: "SPDY is active for sub-documents included in the top-level document",
    }, {
      name: "active",
      tooltip: "SPDY is active for the top-level document",
    }
  ],
  minShowState: 0,

  start: function () {
    SPDYObserver.minShowState = Cc["@mozilla.org/preferences-service;1"]
                                    .getService(Components.interfaces.nsIPrefService)
                                    .getBranch("extensions.spdyindicator.").minShowState;

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
    var state = gBrowser.selectedBrowser.getUserData("__spdyindicator_spdystate") || 0;
    if (gBrowser.currentURI.scheme === "https") {
      // page has loaded to the state where we can retrieve the URI
      var spdyRequests = gBrowser.selectedBrowser.getUserData("__spdyindicator_spdyrequests");
      var newState;
      if (!spdyRequests)                              newState = 1;
      else {
        if (gBrowser.currentURI.spec in spdyRequests) newState = 3;
        else                                          newState = 2;
        // clear the requests cache
        gBrowser.selectedBrowser.setUserData("__spdyindicator_spdyrequests", null, null);
      }
      // set new state
      if (newState > state) {
        state = newState;
        gBrowser.selectedBrowser.setUserData("__spdyindicator_spdystate", state, null);
      }
    }
    // change indicator state
    var indicator = document.getElementById("spdyindicator-icon");
    var indicatorState = SPDYObserver.indicatorStates[state];
    indicator.setAttribute("hidden", state >= SPDYObserver.minShowState);
    indicator.setAttribute("state", indicatorState.name);
    indicator.setAttribute("tooltiptext", indicatorState.tooltip);
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
