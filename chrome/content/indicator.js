let Ci = Components.interfaces;
let Cc = Components.classes;

var SPDYObserver = {
  cache: null,

  start: function () {
    var observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
    observerService.addObserver(SPDYObserver, "http-on-examine-response", false);

    window.addEventListener("load", function () {
      gBrowser.addEventListener("load", SPDYObserver.update, true);
      gBrowser.addEventListener("select", SPDYObserver.update, false);
    }, false);

    SPDYObserver.cache = {};
  },

  update: function () {
    var indicator = document.getElementById("spdyindicator-icon");

    var url = content.document.URL;
    var spdy = false;
    if (url in SPDYObserver.cache) {
      spdy = SPDYObserver.cache[url];
    }
    indicator.hidden = spdy ? null : "true";
  },

  observe: function (subject, topic, data)  {
    switch (topic) {
      case "http-on-examine-response":
        subject.QueryInterface(Ci.nsIHttpChannel);
        var url = subject.URI.asciiSpec;
        var spdyHeader = null;
        try {
          spdyHeader = subject.getResponseHeader("X-Firefox-Spdy");
        } catch (e) {}
        SPDYObserver.cache[url] = spdyHeader && spdyHeader.length > 0;

        SPDYObserver.update();
        break;
    }
  }
};

SPDYObserver.start();
