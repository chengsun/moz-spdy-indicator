var EXPORTED_SYMBOLS = ["SPDYManager"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");

// this is kludgy: in order to prevent unbounded memory growth,
// we limit the number of SPDY-requested prePaths to this number
const SPDYREQUESTS_MAXSIZE = 20;

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

// get the chrome window from a content window
function getChromeWindow(domWindow) {
  return domWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                  .getInterface(Ci.nsIWebNavigation)
                  .QueryInterface(Ci.nsIDocShellTreeItem)
                  .rootTreeItem
                  .QueryInterface(Ci.nsIInterfaceRequestor)
                  .getInterface(Ci.nsIDOMWindow);
}

const prefBranchName = "extensions.spdyindicator.";
var SPDYManager = {
  // private
  indicators: [],
  branch: Services.prefs.getBranch(prefBranchName),

  createIndicator: function (window) {
    let indicator = new SPDYIndicator(window);
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
    defaultBranch.setBoolPref("showDebug", false);
  },

  observe: function (subject, topic, data)  {
    switch (topic) {
      case "http-on-examine-response":
      case "http-on-examine-cached-response":
      case "http-on-examine-merged-response":
        subject.QueryInterface(Ci.nsIHttpChannel);

        // make sure we are requested via SPDY
        let spdyHeader = null;
        try {
          spdyHeader = subject.getResponseHeader("X-Firefox-Spdy");
        } catch (e) {}
        if (!spdyHeader || !spdyHeader.length) return;

        // find the browser which this request originated from
        let domWindow = getLoadContext(subject);
        if (!domWindow) return;
        let window = getChromeWindow(domWindow);

        // notify the appropriate indicator
        let indicator = null;
        for (let i in this.indicators) {
          if (this.indicators[i].window === window) {
            indicator = this.indicators[i];
            break;
          }
        }
        if (!indicator) {
          debug("Could not find indicator from chrome window for request");
        } else {
          indicator.spdyRequested(domWindow, subject.URI, spdyHeader);
        }
        break;
    }
  },

  // used by bootstrap.js
  startup: function (browser) {
    this.setDefaultPrefs();

    // add response header observers
    Services.obs.addObserver(this, "http-on-examine-response", false);
    Services.obs.addObserver(this, "http-on-examine-merged-response", false);
    Services.obs.addObserver(this, "http-on-examine-cached-response", false);

    // add indicators for existing windows
    let browserEnum = Services.wm.getEnumerator("navigator:browser");
    while (browserEnum.hasMoreElements()) {
      this.createIndicator(browserEnum.getNext());
    }
    // listen for window open/close events
    Services.ww.registerNotification(this.newWindowListener.bind(this));
  },

  shutdown: function () {
    // remove response header observers
    Services.obs.removeObserver(this, "http-on-examine-response");
    Services.obs.removeObserver(this, "http-on-examine-merged-response");
    Services.obs.removeObserver(this, "http-on-examine-cached-response");

    // stop and destroy indicators for existing windows
    for (let i in this.indicators) {
      this.indicators[i].stop();
    }
    this.indicators = [];
    // stop listening for window open/close events
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
    }, {
      name: "spdy2",
      tooltip: "SPDY 2 is active for the top-level document",
    }, {
      name: "spdy3",
      tooltip: "SPDY 3 is active for the top-level document",
    }, {
      name: "spdy31",
      tooltip: "SPDY 3.1 is active for the top-level document",
    }, {
      name: "http2",
      tooltip: "HTTP/2 is active for the top-level document",
    }
  ],

  getMinShowState: function () {
    return this.branch.getIntPref("minShowState");
  },
  getShowDebug: function () {
    return this.branch.getBoolPref("showDebug");
  }
};

function debug(s) {
  if (SPDYManager.getShowDebug()) {
    try {
      throw new Error("dummy");
    } catch (e) {
      var stack = e.stack.split('\n');
      stack.splice(0, 1);
      Services.console.logStringMessage("SPDYIndicator: " + s + "\n" + stack.join('\n'));
    }
  }
}

function SPDYIndicator(window) {
  this.window = window;
  this.browser = window.QueryInterface(Ci.nsIInterfaceRequestor)
                       .getInterface(Ci.nsIDOMWindow)
                       .gBrowser;
  this._update_bound = this.update.bind(this);
  this.tabProgressListener.onLocationChange = this.tabProgressListener.onLocationChange.bind(this);
  debug("SPDYIndicator created");
}

SPDYIndicator.prototype = {
  piStylesheet: null,

  start: function () {
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
    this.browser.addEventListener("pageshow", this._update_bound, true);
    this.browser.addEventListener("select", this._update_bound, false);

    // add tab location listener
    this.browser.addTabsProgressListener(this.tabProgressListener);

    debug("SPDYIndicator started");
    this.update();
  },

  stop: function () {
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
    this.browser.removeEventListener("pageshow", this._update_bound, true);
    this.browser.removeEventListener("select", this._update_bound, false);

    // remove tab location listener
    this.browser.removeTabsProgressListener(this.tabProgressListener);

    debug("SPDYIndicator stopped");
  },

  getState: function (browser) {
    return browser.getUserData("__spdyindicator_state") || 0;
  },
  setState: function (browser, newState) {
    browser.setUserData("__spdyindicator_state", newState, null);
    this.update();
  },
  updateState: function (browser, newState) {
    let oldState = this.getState(browser);
    if (newState > oldState)
      this.setState(browser, newState);
  },

  isTopLevelSPDY: function (browser) {
    let spdyRequests = browser.getUserData("__spdyindicator_spdyrequests");
    let currentPath = browser.getUserData("__spdyindicator_path") ||
                      browser.currentURI.prePath;
    return (spdyRequests && spdyRequests.indexOf(currentPath) !== -1);
  },

  updateStateForSPDY: function (browser) {
    let spdyVersions = browser.getUserData("__spdyindicator_spdyversions");
    let currentPath = browser.getUserData("__spdyindicator_path") ||
                      browser.currentURI.prePath;

    let state = 3;
    if (spdyVersions && spdyVersions.hasOwnProperty(currentPath)) {
      let version = spdyVersions[currentPath];
      if (version.match(/^h2/)) {
        state = 7;
      } else if (version === "3.1") {
        state = 6;
      } else if (version === "3") {
        state = 5;
      } else if (version === "2") {
        state = 4;
      }
    }
    this.updateState(browser, state);
  },

  update: function () {
    let state = this.getState(this.browser.selectedBrowser);
    // change indicator state
    let indicator = this.window.document.getElementById("spdyindicator-icon");
    let indicatorState = SPDYManager.indicatorStates[state];
    indicator.setAttribute("hidden", state < SPDYManager.getMinShowState());
    indicator.setAttribute("state", indicatorState.name);
    indicator.setAttribute("tooltiptext", indicatorState.tooltip);
  },
  _update_bound: null,

  spdyRequested: function (domWindow, uri, version) {
    debug("Requested " + uri.asciiSpec);
    debug("SPDY Version " + version);

    let browser = this.browser.getBrowserForDocument(domWindow.top.document);
    if (!browser) return;

    let spdyRequests = browser.getUserData("__spdyindicator_spdyrequests") || [];
    let spdyVersions = browser.getUserData("__spdyindicator_spdyversions") || {};
    if (spdyRequests.indexOf(uri.prePath) === -1) {
      spdyRequests.push(uri.prePath);
      spdyVersions[uri.prePath] = version;
    }
    if (spdyRequests.length > SPDYREQUESTS_MAXSIZE) {
      let splices = spdyRequests.splice(0, spdyRequests.length - SPDYREQUESTS_MAXSIZE);
      splices.forEach(function (element) {
        if (spdyVersions.hasOwnProperty(element)) {
          delete spdyVersions[element];
        }
      });
    }
    browser.setUserData("__spdyindicator_spdyrequests", spdyRequests, null);
    browser.setUserData("__spdyindicator_spdyversions", spdyVersions, null);

    if (this.isTopLevelSPDY(browser)) {
      this.updateStateForSPDY(browser);
    } else {
      this.updateState(browser, 2);
    }
  },

  tabProgressListener: {
    onLocationChange: function (browser, webProgress, request, URI, flags) {
      browser.setUserData("__spdyindicator_path", URI.prePath, null);
      this.setState(browser, 0);
      if (this.isTopLevelSPDY(browser)) {
        this.updateStateForSPDY(browser);
      }
    },
    onProgressChange: function () {},
    onSecurityChange: function () {},
    onStateChange: function () {},
    onStatusChange: function () {}
  },
};

// vim: filetype=javascript
