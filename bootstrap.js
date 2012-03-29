const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");

function startup(data, reason) {
  Cu.import("chrome://spdyindicator/content/indicator.jsm");
  SPDYManager.startup();
}

function shutdown(data, reason) {
  if (reason == APP_SHUTDOWN) return;

  Cu.import("chrome://spdyindicator/content/indicator.jsm");
  SPDYManager.shutdown();
}

function install(data, reason) {
  // o hai there new friend! :D
}
function uninstall(data, reason) {
  // y u do this to me :(
}
