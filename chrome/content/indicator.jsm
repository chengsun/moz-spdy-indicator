var EXPORTED_SYMBOLS = ["SPDYManager"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");

const prefBranchName = "extensions.spdyindicator.";
var SPDYManager = {
  // private
  indicators: [],
  branch: Services.prefs.getBranch(prefBranchName),

  createIndicator: function (browser) {
    let indicator = new SPDYIndicator(browser);
    indicator.start();
    this.indicators.push(indicator);
    return indicator;
  },

  newWindowListener: function (subject, topic, data) {
    let window = subject.QueryInterface(Ci.nsIDOMWindow);
    switch (topic) {
    case "domwindowopened":
      let self = this;
      window.addEventListener('load', function onLoad() {
        window.removeEventListener('load', onLoad, false);
        if (window.document.documentElement.getAttribute('windowtype') === "navigator:browser") {
          self.createIndicator(window);
        }
      }, false);
      break;
    case "domwindowclosed":
      for (let i in this.indicators) {
        if (this.indicators[i].window === window) {
          this.indicators[i].stop();
          this.indicators.splice(i, 1);
          break;
        }
      }
      break;
    }
  },

  setDefaultPrefs: function () {
    let defaultBranch = Services.prefs.getDefaultBranch(prefBranchName);
    defaultBranch.setIntPref("minShowState", 2);
  },

  // used by bootstrap.js
  startup: function (browser) {
    this.setDefaultPrefs();

    let browserEnum = Services.wm.getEnumerator("navigator:browser");
    while (browserEnum.hasMoreElements()) {
      this.createIndicator(browserEnum.getNext());
    }
    Services.ww.registerNotification(this.newWindowListener.bind(this));
  },

  shutdown: function () {
    for (let i in this.indicators) {
      this.indicators[i].stop();
    }
    this.indicators = [];
    Services.ww.unregisterNotification(this.newWindowListener);
  },

  // used by SPDYIndicator
  indicatorStates: [
    {
      name: "unknown",
      tooltip: "SPDY state unknown",
    }, {
      name: "inactive",
      tooltip: "SPDY is inactive",
    }, {
      name: "subactive",
      tooltip: "SPDY is active for some sub-documents included in the top-level document",
    }, {
      name: "active",
      tooltip: "SPDY is active for the top-level document",
    }
  ],

  getMinShowState: function () {
    return this.branch.getIntPref("minShowState");
  }
};

function getLoadContext(request) {
  let loadContext = null;
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
}

function debug(s) {
  Services.console.logStringMessage(s);
}

function SPDYIndicator(window) {
  this.window = window;
  this.browser = window.QueryInterface(Ci.nsIInterfaceRequestor)
                       .getInterface(Ci.nsIDOMWindow)
                       .gBrowser;
  debug("SPDYIndicator created");
}

SPDYIndicator.prototype = {
  piStylesheet: null,

  start: function () {
    // add response header observers
    Services.obs.addObserver(this, "http-on-examine-response", false);
    Services.obs.addObserver(this, "http-on-examine-merged-response", false);
    Services.obs.addObserver(this, "http-on-examine-cached-response", false);

    // insert our stylesheet
    this.piStylesheet = this.window.document.createProcessingInstruction('xml-stylesheet',
              'href="chrome://spdyindicator/skin/overlay.css" type="text/css"');
    this.window.document.insertBefore(this.piStylesheet, this.window.document.firstChild);

    // create icon
    let spdyIndicator = this.window.document.createElement('image');
    spdyIndicator.id = 'spdyindicator-icon';
    spdyIndicator.className = 'urlbar-icon';

    // insert icon in urlbar
    let urlbarIcons = this.window.document.getElementById('urlbar-icons');
    urlbarIcons.insertBefore(spdyIndicator, urlbarIcons.firstChild);

    // add browser event listeners
    this._update_bound = this.update.bind(this);
    this.browser.addEventListener("pageshow", this._update_bound, true);
    this.browser.addEventListener("select", this._update_bound, false);

    debug("SPDYIndicator started");
    this.update();
  },

  stop: function () {
    // remove response header observers
    Services.obs.removeObserver(this, "http-on-examine-response");
    Services.obs.removeObserver(this, "http-on-examine-merged-response");
    Services.obs.removeObserver(this, "http-on-examine-cached-response");

    // remove stylesheet
    if (this.piStylesheet.parentNode) {
      this.piStylesheet.parentNode.removeChild(this.piStylesheet);
    } else {
      debug("SPDYIndicator could not find stylesheet");
    }


    // remove icon
    let spdyIndicator = this.window.document.getElementById('spdyindicator-icon');
    if (spdyIndicator.parentNode) {
      spdyIndicator.parentNode.removeChild(spdyIndicator);
    } else {
      debug("SPDYIndicator could not find icon");
    }

    // remove browser event listeners
    this.browser.removeEventListener("pageshow", this._update_bound);
    this.browser.removeEventListener("select", this._update_bound);

    debug("SPDYIndicator stopped");
  },

  update: function () {
    let state = 0;
    if (this.browser.currentURI.scheme === "https") {
      // page has loaded to the state where we can retrieve the URI
      let spdyRequests = this.browser.selectedBrowser.getUserData("__spdyindicator_spdyrequests");
      if (!spdyRequests)                              state = 1;
      else {
        if (this.browser.currentURI.spec in spdyRequests) state = 3;
        else                                          state = 2;
      }
    }
    // change indicator state
    let indicator = this.window.document.getElementById("spdyindicator-icon");
    let indicatorState = SPDYManager.indicatorStates[state];
    indicator.setAttribute("hidden", state < SPDYManager.getMinShowState());
    indicator.setAttribute("state", indicatorState.name);
    indicator.setAttribute("tooltiptext", indicatorState.tooltip);
  },
  _update_bound: null,

  observe: function (subject, topic, data)  {
    switch (topic) {
      case "http-on-examine-response":
      case "http-on-examine-cached-response":
      case "http-on-examine-merged-response":
        subject.QueryInterface(Ci.nsIHttpChannel);
        let requestURI = subject.URI.spec;

        // make sure we are requested via SPDY
        let spdyHeader = null;
        try {
          spdyHeader = subject.getResponseHeader("X-Firefox-Spdy");
        } catch (e) {}
        if (!spdyHeader || !spdyHeader.length) return;

        // find the browser which this request originated from
        let win = getLoadContext(subject);
        if (!win) return;
        let browser = this.browser.getBrowserForDocument(win.top.document);
        if (!browser) return;

        let spdyRequests = browser.getUserData("__spdyindicator_spdyrequests") || {};
        spdyRequests[requestURI] = true;
        browser.setUserData("__spdyindicator_spdyrequests", spdyRequests, null);
        this.update();
        break;
    }
  }
};

// vim: filetype=javascript
